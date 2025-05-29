const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const axios = require('axios');

class FFXVExtractor {
    constructor() {
        this.dbPath = null;
        this.db = null;
        this.extractionCancelled = false;
        this.characterMappings = null;
        this.languages = {
            'us': 'English',
            'jp': 'Japanese',
            'de': 'German',
            'fr': 'French'
        };

        this.loadSections();
        this.loadCharacterMappings();
        this.initializeLogFile();
    }

    buildUrl(section, langCode = null) {
        const baseUrl = 'https://ff15.aikotoba.jp';

        if (section.startsWith('dir/')) {
            // Story sections: dir/16009story_v_cp00 -> /data/16009story_v_cp00_list.json
            const storyId = section.replace('dir/', '');
            if (langCode) {
                return `${baseUrl}/data/${storyId}_${langCode}.json`;
            } else {
                return `${baseUrl}/data/${storyId}_list.json`;
            }
        } else if (section.startsWith('wiki/')) {
            // Wiki sections: wiki/enemy -> /wiki/wiki_enemy.json
            const wikiType = section.replace('wiki/', '');
            const langSuffix = langCode ? `_${langCode}` : '';
            return `${baseUrl}/wiki/wiki_${wikiType}${langSuffix}.json`;
        } else {
            // Simple sections: nowloading -> /nowloading/nowloading.json
            const langSuffix = langCode ? `_${langCode}` : '';
            return `${baseUrl}/${section}/${section}${langSuffix}.json`;
        }
    }

    storeSectionUrls() {
        if (!this.sections || !this.db) return false;

        const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO section_urls 
        VALUES (?, ?)
    `);

        const transaction = this.db.transaction(() => {
            for (const sectionConfig of this.sections) {
                const viewUrl = `https://ff15.aikotoba.jp/#/${sectionConfig.name}`;
                insertStmt.run(sectionConfig.name, viewUrl);
            }
        });

        try {
            transaction();
            this.writeToLogFile(`Stored ${this.sections.length} section URL mappings`, 'SUCCESS');
            return true;
        } catch (error) {
            this.writeToLogFile(`Failed to store section URLs: ${error.message}`, 'ERROR');
            return false;
        }
    }

    async selectDatabaseLocation() {
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Open Existing Database', 'Create New Database', 'Cancel'],
            defaultId: 0,
            title: 'Database Selection',
            message: 'Would you like to open an existing database or create a new one?'
        });
        if (response === 2) return null; // Cancel

        let result;
        if (response === 0) {
            // Open existing database
            result = await dialog.showOpenDialog(mainWindow, {
                title: 'Select Existing Database File',
                defaultPath: path.join(os.homedir(), 'Documents'),
                filters: [
                    { name: 'Database Files', extensions: ['db'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });

            if (!result.canceled && result.filePaths.length > 0) {
                this.dbPath = result.filePaths[0];
                return this.dbPath;
            }
        } else {
            // Create new database
            result = await dialog.showSaveDialog(mainWindow, {
                title: 'Create New Database File',
                defaultPath: path.join(os.homedir(), 'Documents', 'FFXVFullLines.db'),
                filters: [
                    { name: 'Database Files', extensions: ['db'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (!result.canceled) {
                this.dbPath = result.filePath;
                return this.dbPath;
            }
        }

        return null;
    }

    initializeDatabase() {
        if (!this.dbPath) {
            throw new Error('Database path not selected');
        }

        this.db = new Database(this.dbPath);

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS fulllines (
            id TEXT,
            section TEXT,
            language TEXT,
            lang_name TEXT,
            text TEXT,
            PRIMARY KEY (id, section, language)
        );
        
        CREATE TABLE IF NOT EXISTS character_mappings (
            dialogue_id TEXT PRIMARY KEY,
            us_name TEXT,
            jp_name TEXT, 
            de_name TEXT,
            fr_name TEXT
        );
        
        CREATE TABLE IF NOT EXISTS section_urls (
            section_name TEXT PRIMARY KEY,
            view_url TEXT NOT NULL
        );
        
        -- Performance indexes
        CREATE INDEX IF NOT EXISTS idx_fulllines_text ON fulllines(text);
        CREATE INDEX IF NOT EXISTS idx_fulllines_section ON fulllines(section);
        CREATE INDEX IF NOT EXISTS idx_fulllines_language ON fulllines(language);
        CREATE INDEX IF NOT EXISTS idx_fulllines_id_section ON fulllines(id, section);
        
        -- Character mapping indexes
        CREATE INDEX IF NOT EXISTS idx_char_us ON character_mappings(us_name) WHERE us_name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_char_jp ON character_mappings(jp_name) WHERE jp_name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_char_de ON character_mappings(de_name) WHERE de_name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_char_fr ON character_mappings(fr_name) WHERE fr_name IS NOT NULL;
    `);
    }

    async testConnection() {
        const testSections = ['nowloading', 'story_v_cp01'];
        let failures = 0;

        for (const section of testSections) {
            if (this.extractionCancelled) break;

            try {
                // Test base manifest first
                const baseUrl = `https://ff15.aikotoba.jp/${section}/${section}.json`;
                await axios.get(baseUrl, { timeout: 10000 });

                // Test English language file
                const usUrl = `https://ff15.aikotoba.jp/${section}/${section}_us.json`;
                await axios.get(usUrl, { timeout: 10000 });

                // Test French language file
                const frUrl = `https://ff15.aikotoba.jp/${section}/${section}_fr.json`;
                await axios.get(frUrl, { timeout: 10000 });

            } catch (error) {
                failures++;
            }
        }

        return failures <= 1; // Allow 1 failure out of 2 sections
    }

    /**
     * Check what sections/languages have already been extracted
     */
    getExistingData() {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        const stmt = this.db.prepare(`
        SELECT DISTINCT section, language 
        FROM fulllines 
        ORDER BY section, language
    `);

        const existing = stmt.all();
        const existingMap = new Map();

        existing.forEach(row => {
            if (!existingMap.has(row.section)) {
                existingMap.set(row.section, new Set());
            }
            existingMap.get(row.section).add(row.language);
        });

        return existingMap;
    }

    /**
     * Clean up incomplete data for a specific section
     */
    cleanupIncompleteSection(section) {
        if (!this.db) return false;

        console.log(`Checking section for cleanup: ${section}`);

        const sectionConfig = this.sections.find(s => s.name === section);
        if (!sectionConfig) {
            console.log(`Section config not found for: ${section}`);
            return false;
        }

        const expectedLanguages = sectionConfig.languages;
        console.log(`Expected languages for ${section}:`, expectedLanguages);

        const stmt = this.db.prepare('SELECT DISTINCT language FROM fulllines WHERE section = ?');
        const existingLanguages = stmt.all(section).map(row => row.language);
        console.log(`Existing languages for ${section}:`, existingLanguages);

        // If section is incomplete (doesn't have all expected languages), remove it
        if (existingLanguages.length > 0 && existingLanguages.length < expectedLanguages.length) {
            console.log(`Cleaning up incomplete section: ${section} (has ${existingLanguages.length}/${expectedLanguages.length} languages)`);
            const deleteStmt = this.db.prepare('DELETE FROM fulllines WHERE section = ?');
            const result = deleteStmt.run(section);
            console.log(`Deleted ${result.changes} rows for section: ${section}`);
            return true; // Indicates cleanup occurred
        }

        console.log(`Section ${section} is complete or empty, skipping cleanup`);
        return false;
    }

    /**
     * Get extraction progress statistics
     */
    // Replace the existing getExtractionProgress method
    getExtractionProgress() {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        const existing = this.getExistingData();
        const totalSections = this.sections.length;
        const completedSections = [];
        const incompleteSections = [];

        this.sections.forEach(sectionConfig => {
            const sectionLanguages = existing.get(sectionConfig.name);
            const expectedLanguageCount = sectionConfig.languages.length;

            if (sectionLanguages) {
                const actualLanguageCount = sectionLanguages.size;

                if (actualLanguageCount === expectedLanguageCount) {
                    completedSections.push(sectionConfig.name);
                } else if (actualLanguageCount > 0) {
                    incompleteSections.push({
                        section: sectionConfig.name,
                        hasLanguages: Array.from(sectionLanguages),
                        missingLanguages: sectionConfig.languages.filter(lang => !sectionLanguages.has(lang)),
                        expectedCount: expectedLanguageCount,
                        actualCount: actualLanguageCount
                    });
                }
            }
        });

        return {
            total: totalSections,
            completed: completedSections.length,
            incomplete: incompleteSections.length,
            remaining: totalSections - completedSections.length,
            completedSections,
            incompleteSections,
            hasAnyData: existing.size > 0
        };
    }

    /**
     * Clean up partial data from current extraction session
     */
    cleanupPartialExtractionSession() {
        const progress = this.getExtractionProgress();
        let cleanedCount = 0;

        console.log(`Starting cleanup of ${progress.incompleteSections.length} incomplete sections`);

        progress.incompleteSections.forEach(incomplete => {
            console.log(`Attempting to clean section: ${incomplete.section}`);
            if (this.cleanupIncompleteSection(incomplete.section)) {
                cleanedCount++;
                console.log(`Successfully cleaned section: ${incomplete.section}`);
            } else {
                console.log(`No cleanup needed for section: ${incomplete.section}`);
            }
        });

        console.log(`Cleanup complete. Cleaned ${cleanedCount} sections`);
        return cleanedCount;
    }

    /**
     * Validate database integrity
     */
    validateDatabaseIntegrity() {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        const issues = [];

        // Check for sections with missing languages
        const progress = this.getExtractionProgress();
        if (progress.incompleteSections.length > 0) {
            issues.push({
                type: 'incomplete_sections',
                count: progress.incompleteSections.length,
                sections: progress.incompleteSections
            });
        }

        // Check for duplicate entries (shouldn't happen with INSERT OR REPLACE, but good to verify)
        const duplicateCheck = this.db.prepare(`
        SELECT id, section, language, COUNT(*) as count 
        FROM fulllines 
        GROUP BY id, section, language 
        HAVING COUNT(*) > 1
    `);
        const duplicates = duplicateCheck.all();

        if (duplicates.length > 0) {
            issues.push({
                type: 'duplicates',
                count: duplicates.length,
                entries: duplicates
            });
        }

        // Check character mappings
        const charMappingCheck = this.db.prepare('SELECT COUNT(*) as count FROM character_mappings');
        const charMappingCount = charMappingCheck.get();

        console.log(`Database validation: ${charMappingCount.count} character mappings found`);

        return {
            isValid: issues.length === 0,
            issues,
            stats: {
                totalEntries: progress.completed * 4, // Rough estimate
                characterMappings: charMappingCount.count,
                completeSections: progress.completed,
                incompleteSections: progress.incomplete
            }
        };
    }

    hasExtractedData() {
        if (!this.db) return false;

        try {
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM fulllines LIMIT 1');
            const result = stmt.get();
            return result.count > 0;
        } catch (error) {
            console.error('Error checking for extracted data:', error);
            return false;
        }
    }

    getDatabaseSummary() {
        if (!this.db) {
            return { hasData: false, error: 'Database not initialized' };
        }

        try {
            const totalStmt = this.db.prepare('SELECT COUNT(*) as total FROM fulllines');
            const totalResult = totalStmt.get();

            return {
                hasData: totalResult.total > 0,
                totalEntries: totalResult.total
            };
        } catch (error) {
            return { hasData: false, error: error.message };
        }
    }

    cancelExtraction() {
        this.extractionCancelled = true;
    }

    /**
     * Enhanced extractData with resume capability and improved error handling
     */
    async extractDataWithResume(progressCallback, resumeMode = false) {
        this.extractionCancelled = false;
        let sectionsToProcess = [...this.sections];
        let startingProgress = 0;

        if (resumeMode) {
            const progress = this.getExtractionProgress();

            // Clean up incomplete sections
            let cleanedCount = 0;
            progress.incompleteSections.forEach(incomplete => {
                if (this.cleanupIncompleteSection(incomplete.section)) {
                    cleanedCount++;
                }
            });

            if (cleanedCount > 0) {
                const cleanupMessage = `Cleaned up ${cleanedCount} incomplete sections`;
                this.writeToLogFile(cleanupMessage, 'INFO');
                progressCallback({
                    status: 'cleanup',
                    message: cleanupMessage
                });
            }

            // Only process sections that aren't complete
            sectionsToProcess = this.sections.filter(sectionConfig =>
                !progress.completedSections.includes(sectionConfig.name)
            );

            startingProgress = progress.completed * Object.keys(this.languages).length;
            const resumeMessage = `Resuming extraction. ${progress.completed}/${progress.total} sections complete. ${sectionsToProcess.length} sections remaining.`;
            this.writeToLogFile(resumeMessage, 'INFO');
            progressCallback({
                status: 'resume',
                message: resumeMessage
            });
        }

        const totalFiles = sectionsToProcess.reduce((total, sectionConfig) => {
            return total + sectionConfig.languages.length;
        }, 0);
        let currentIndex = startingProgress;
        let successCount = 0;
        let failCount = 0;
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;
        const insertStmt = this.db.prepare('INSERT OR REPLACE INTO fulllines VALUES (?, ?, ?, ?, ?)');

        for (const sectionConfig of sectionsToProcess) {
            const sectionName = sectionConfig.name;
            if (this.extractionCancelled) {
                // Clean up current incomplete section on cancellation
                this.cleanupIncompleteSection(sectionName);
                const cancelMessage = 'Extraction cancelled by user';
                this.writeToLogFile(cancelMessage, 'INFO');
                progressCallback({
                    current: currentIndex,
                    total: totalFiles + startingProgress,
                    status: 'cancelled'
                });
                return { successCount, failCount, cancelled: true };
            }
            let sectionSuccess = true;

            // First, fetch the base manifest for this section
            try {
                const baseUrl = this.buildUrl(sectionName);
                const baseAttemptMessage = `Attempting base URL: ${baseUrl}`;

                this.writeToLogFile(baseAttemptMessage, 'INFO');
                progressCallback({
                    status: 'info',
                    message: baseAttemptMessage
                });

                await axios.get(baseUrl, { timeout: 15000 });
                consecutiveFailures = 0; // Reset on success
            } catch (error) {
                consecutiveFailures++; // Increment on failure
                sectionSuccess = false;

                // Check if we've hit the consecutive failure limit
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    const errorMessage = `Operation cancelled: ${MAX_CONSECUTIVE_FAILURES} consecutive failures detected. Last error: ${error.message}`;
                    // Clean up any partial data from this extraction session
                    this.cleanupPartialExtractionSession();

                    this.writeToLogFile(errorMessage, 'ERROR');
                    progressCallback({
                        current: currentIndex,
                        total: totalFiles + startingProgress,
                        status: 'error',
                        error: errorMessage
                    });
                    throw new Error(errorMessage);
                }

                // If base manifest fails, skip this entire section
                const skippedFiles = sectionConfig.languages.length;
                currentIndex += skippedFiles;
                failCount += skippedFiles;

                const baseFailMessage = `Base manifest failed: ${error.message}`;
                this.writeToLogFile(`Section ${sectionName} - ${baseFailMessage}`, 'ERROR');

                for (let i = 0; i < skippedFiles; i++) {
                    progressCallback({
                        current: currentIndex - skippedFiles + i + 1,
                        total: totalFiles + startingProgress,
                        currentFile: `${sectionName} (base manifest failed)`,
                        status: 'error',
                        error: baseFailMessage
                    });
                }
                continue;
            }

            // Get character mappings once
            if (this.characterMappings && !this.characterMappingsStored) {
                const charMessage = 'Storing character mappings in database...';
                this.writeToLogFile(charMessage, 'INFO');
                progressCallback({
                    status: 'info',
                    message: charMessage
                });

                if (this.storeCharacterMappings()) {
                    this.characterMappingsStored = true;
                }
            }

            // Store section URLs once
            if (!this.sectionUrlsStored) {
                const urlMessage = 'Storing section URL mappings...';
                this.writeToLogFile(urlMessage, 'INFO');
                progressCallback({
                    status: 'info',
                    message: urlMessage
                });

                if (this.storeSectionUrls()) {
                    this.sectionUrlsStored = true;
                }
            }

            // Now fetch each language file for this section
            for (const langCode of sectionConfig.languages) { // Fixed: iterate over sectionConfig.languages
                if (this.extractionCancelled) {
                    this.cleanupIncompleteSection(sectionName);
                    const cancelMessage = 'Extraction cancelled by user';
                    this.writeToLogFile(cancelMessage, 'INFO');
                    progressCallback({
                        current: currentIndex,
                        total: totalFiles + startingProgress,
                        status: 'cancelled'
                    });
                    return { successCount, failCount, cancelled: true };
                }

                currentIndex++;
                const url = this.buildUrl(sectionName, langCode);
                const currentFileName = `${sectionName}_${langCode}.json`;
                const langName = this.languages[langCode];

                const urlAttemptMessage = `Attempting language URL: ${url}`;
                this.writeToLogFile(urlAttemptMessage, 'INFO');
                progressCallback({
                    status: 'info',
                    message: urlAttemptMessage
                });

                progressCallback({
                    current: currentIndex,
                    total: totalFiles + startingProgress,
                    currentFile: currentFileName,
                    status: 'downloading'
                });

                try {
                    const response = await axios.get(url, { timeout: 15000 });
                    const data = response.data;

                    // Insert all entries in a transaction for better performance
                    const transaction = this.db.transaction((entries) => {
                        for (const [id, text] of entries) {
                            insertStmt.run(id, sectionName, langCode, langName, text);
                        }
                    });

                    transaction(Object.entries(data));

                    successCount++;
                    consecutiveFailures = 0; // Reset consecutive failures on success

                    const successMessage = `Downloaded ${currentFileName} (${Object.keys(data).length} entries)`;
                    this.writeToLogFile(successMessage, 'SUCCESS');
                    progressCallback({
                        current: currentIndex,
                        total: totalFiles + startingProgress,
                        currentFile: currentFileName,
                        status: 'success',
                        entryCount: Object.keys(data).length
                    });

                } catch (error) {
                    failCount++;
                    consecutiveFailures++; // Increment consecutive failures
                    sectionSuccess = false;

                    const errorMessage = `Failed ${currentFileName}: ${error.message}`;
                    this.writeToLogFile(errorMessage, 'ERROR');
                    progressCallback({
                        current: currentIndex,
                        total: totalFiles + startingProgress,
                        currentFile: currentFileName,
                        status: 'error',
                        error: error.message
                    });

                    // Check if we've hit the consecutive failure limit
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        // Clean up incomplete section and any partial data
                        this.cleanupIncompleteSection(sectionName);
                        this.cleanupPartialExtractionSession();

                        const consecutiveErrorMessage = `Operation cancelled: ${MAX_CONSECUTIVE_FAILURES} consecutive failures detected. Last error: ${error.message}`;
                        this.writeToLogFile(consecutiveErrorMessage, 'ERROR');
                        progressCallback({
                            current: currentIndex,
                            total: totalFiles + startingProgress,
                            status: 'error',
                            error: consecutiveErrorMessage
                        });
                        throw new Error(consecutiveErrorMessage);
                    }
                }

                // Respectful fetch
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // If section failed, clean it up
            if (!sectionSuccess) {
                const cleanupMessage = `Cleaning up incomplete section: ${sectionName}`;
                this.writeToLogFile(cleanupMessage, 'INFO');
                this.cleanupIncompleteSection(sectionName);
            }
        }

        const completionMessage = `Extraction completed. Success: ${successCount}, Failed: ${failCount}`;
        this.writeToLogFile(completionMessage, 'INFO');
        return { successCount, failCount, cancelled: false };
    }

    async extractData(progressCallback) {
        return this.extractDataWithResume(progressCallback, false);
    }

    search(query, language = null, section = null, limit = null) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        let sql = `
        SELECT f.*, 
               CASE f.language
                   WHEN 'us' THEN c.us_name
                   WHEN 'jp' THEN c.jp_name  
                   WHEN 'de' THEN c.de_name
                   WHEN 'fr' THEN c.fr_name
                   ELSE NULL
               END as speaker_name,
               u.view_url
        FROM fulllines f 
        LEFT JOIN character_mappings c ON f.id = c.dialogue_id
        LEFT JOIN section_urls u ON f.section = u.section_name
        WHERE LOWER(f.text) LIKE LOWER(?)
    `;
        const params = [`%${query}%`];

        if (language) {
            sql += ' AND f.language = ?';
            params.push(language);
        }

        if (section) {
            sql += ' AND f.section = ?';
            params.push(section);
        }

        sql += ` ORDER BY f.section, f.language`;

        // Only add limit if specified
        if (limit && limit > 0) {
            sql += ` LIMIT ${limit}`;
        }

        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params);

        return rows.map(row => ({
            id: row.id,
            section: row.section,
            language: row.language,
            langName: row.lang_name,
            text: row.text,
            speakerName: row.speaker_name || '???',
            sectionUrl: row.view_url
        }));
    }

    searchByCharacter(characterName, language = null, section = null, limit = null) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        let sql = `
        SELECT f.*, 
               CASE f.language
                   WHEN 'us' THEN c.us_name
                   WHEN 'jp' THEN c.jp_name  
                   WHEN 'de' THEN c.de_name
                   WHEN 'fr' THEN c.fr_name
                   ELSE NULL
               END as speaker_name,
               u.view_url
        FROM fulllines f 
        JOIN character_mappings c ON f.id = c.dialogue_id
        LEFT JOIN section_urls u ON f.section = u.section_name
        WHERE CASE f.language
                  WHEN 'us' THEN c.us_name
                  WHEN 'jp' THEN c.jp_name  
                  WHEN 'de' THEN c.de_name
                  WHEN 'fr' THEN c.fr_name
                  ELSE c.us_name
              END = ?
    `;
        const params = [characterName];

        if (language) {
            sql += ' AND f.language = ?';
            params.push(language);
        }

        if (section) {
            sql += ' AND f.section = ?';
            params.push(section);
        }

        sql += ` ORDER BY f.section, f.language`;

        // Only add limit if specified
        if (limit && limit > 0) {
            sql += ` LIMIT ${limit}`;
        }

        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params);

        return rows.map(row => ({
            id: row.id,
            section: row.section,
            language: row.language,
            langName: row.lang_name,
            text: row.text,
            speakerName: row.speaker_name || '???',
            sectionUrl: `https://ff15.aikotoba.jp/#/${row.section}`
        }));
    }

    // Get unique speakers for dropdown population
    getUniqueCharacters(language = null) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        let sql, params = [];

        if (language) {
            // Get characters for specific language
            sql = `
            SELECT DISTINCT 
                CASE ? 
                    WHEN 'us' THEN c.us_name
                    WHEN 'jp' THEN c.jp_name  
                    WHEN 'de' THEN c.de_name
                    WHEN 'fr' THEN c.fr_name
                    ELSE c.us_name
                END as character_name
            FROM character_mappings c
            WHERE CASE ? 
                    WHEN 'us' THEN c.us_name
                    WHEN 'jp' THEN c.jp_name  
                    WHEN 'de' THEN c.de_name
                    WHEN 'fr' THEN c.fr_name
                    ELSE c.us_name
                  END IS NOT NULL
            ORDER BY character_name
        `;
            params = [language, language];
        } else {
            // Get all unique characters (use US names as default)
            sql = `
            SELECT DISTINCT c.us_name as character_name
            FROM character_mappings c
            WHERE c.us_name IS NOT NULL
            ORDER BY character_name
        `;
        }

        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params);
        return rows.map(row => row.character_name);
    }

    getStats() {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        const totalStmt = this.db.prepare('SELECT COUNT(*) as total FROM fulllines');
        const totalRow = totalStmt.get();
        const langStmt = this.db.prepare('SELECT language, lang_name, COUNT(*) as count FROM fulllines GROUP BY language');
        const langRows = langStmt.all();
        const sectionStmt = this.db.prepare('SELECT section, COUNT(*) as count FROM fulllines GROUP BY section ORDER BY count DESC');
        const sectionRows = sectionStmt.all();

        const stats = {
            totalEntries: totalRow.total,
            languages: {},
            sections: {}
        };

        langRows.forEach(row => {
            stats.languages[row.language] = {
                name: row.lang_name,
                count: row.count
            };
        });

        sectionRows.forEach(row => {
            stats.sections[row.section] = row.count;
        });

        return stats;
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }

    loadSections() {
        try {
            const sectionsPath = path.join(__dirname, 'sections.json');
            if (fs.existsSync(sectionsPath)) {
                const sectionsData = JSON.parse(fs.readFileSync(sectionsPath, 'utf8'));
                this.sections = sectionsData.sections || [];
                this.sectionsLoadError = null;

                const totalExpected = this.getTotalExpectedSections();
                const jpOnlyCount = this.sections.filter(s => s.languages.length === 1 && s.languages[0] === 'jp').length;
                const fullLanguageCount = this.sections.filter(s => s.languages.length === 4).length;

                console.log(`Loaded ${this.sections.length} sections (${totalExpected} total language files expected)`);
                console.log(`- Full language support: ${fullLanguageCount} sections`);
                console.log(`- JP-only sections: ${jpOnlyCount} sections`);

                return { success: true, sections: this.sections, totalExpected };
            } else {
                this.sectionsLoadError = 'sections.json file not found in application directory';
                this.sections = [];
                return { success: false, error: this.sectionsLoadError };
            }
        } catch (error) {
            this.sectionsLoadError = `Error loading sections.json: ${error.message}`;
            this.sections = [];
            return { success: false, error: this.sectionsLoadError };
        }
    }

    loadCharacterMappings() {
        try {
            const charactersPath = path.join(__dirname, 'characters.json');
            if (fs.existsSync(charactersPath)) {
                const charactersData = JSON.parse(fs.readFileSync(charactersPath, 'utf8'));
                this.characterMappings = charactersData;
                console.log(`Loaded ${Object.keys(charactersData).length} character mappings`);
                return { success: true, count: Object.keys(charactersData).length };
            } else {
                this.characterMappings = null;
                return { success: false, error: 'characters.json file not found' };
            }
        } catch (error) {
            this.characterMappings = null;
            return { success: false, error: `Error loading characters.json: ${error.message}` };
        }
    }

    storeCharacterMappings() {
        if (!this.characterMappings || !this.db) return false;

        const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO character_mappings 
        VALUES (?, ?, ?, ?, ?)
        `);

        const transaction = this.db.transaction(() => {
            for (const [dialogueId, characterData] of Object.entries(this.characterMappings)) {
                insertStmt.run(
                    dialogueId,
                    characterData.us || null,
                    characterData.jp || null,
                    characterData.de || null,
                    characterData.fr || null
                );
            }
        });

        try {
            transaction();
            this.writeToLogFile(`Stored ${Object.keys(this.characterMappings).length} character mappings`, 'SUCCESS');
            return true;
        } catch (error) {
            this.writeToLogFile(`Failed to store character mappings: ${error.message}`, 'ERROR');
            return false;
        }
    }

    initializeLogFile() {
        const documentsPath = path.join(os.homedir(), 'Documents');
        this.logFilePath = path.join(documentsPath, 'FFXVExtractor_log.txt');
        this.writeToLogFile('='.repeat(50));
        this.writeToLogFile(`FFXV Extractor Session Started: ${new Date().toISOString()}`);
        this.writeToLogFile('='.repeat(50));
    }

    writeToLogFile(message, type = 'INFO') {
        if (!this.logFilePath) return;

        try {
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
            fs.appendFileSync(this.logFilePath, logEntry);
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    getTotalExpectedSections() {
        if (!this.sections) return 0;
        return this.sections.reduce((total, section) => {
            return total + section.languages.length;
        }, 0);
    }

    debugCharacterMappings() {
        if (!this.db) {
            console.log('Database not initialized');
            return;
        }

        console.log('=== CHARACTER MAPPING DEBUG ===');

        // Check if character mappings table exists and has data
        const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM character_mappings');
        const countResult = countStmt.get();
        console.log(`Character mappings in database: ${countResult.count}`);

        // Show sample character mappings
        const sampleStmt = this.db.prepare('SELECT * FROM character_mappings LIMIT 10');
        const samples = sampleStmt.all();
        console.log('Sample character mappings:', samples);

        // Check if characters.json is loaded
        console.log(`Characters from file: ${this.characterMappings ? Object.keys(this.characterMappings).length : 'NOT LOADED'}`);

        // Test the getUniqueCharacters method
        try {
            const characters = this.getUniqueCharacters();
            console.log(`getUniqueCharacters returned: ${characters.length} characters`);
            console.log('Sample characters:', characters.slice(0, 10));
        } catch (error) {
            console.error('getUniqueCharacters error:', error);
        }
    }
}

// ----------- RUNTIME -----------
let mainWindow;
let extractor;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        // icon: path.join(__dirname, 'assets/icon.png'), // Add icon if available
        title: 'FFXV Full Lines Extractor'
    });

    mainWindow.loadFile('index.html');

    // Remove menu bar
    mainWindow.setMenuBarVisibility(false);
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }
}

app.whenReady().then(() => {
    createWindow();
    extractor = new FFXVExtractor();
});

app.on('window-all-closed', () => {
    if (extractor) {
        extractor.close();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.handle('select-database-location', async () => {
    try {
        const path = await extractor.selectDatabaseLocation();
        return { success: !!path, path };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('initialize-database', async () => {
    try {
        extractor.initializeDatabase();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('test-connection', async () => {
    try {
        const result = await extractor.testConnection();
        return { success: result };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('start-extraction', async () => {
    try {
        const result = await extractor.extractDataWithResume((progress) => {
            mainWindow.webContents.send('extraction-progress', progress);
        }, false); // resumeMode = false for fresh extraction
        return { success: true, ...result };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('start-extraction-with-resume', async (event, resumeMode = false) => {
    try {
        const result = await extractor.extractDataWithResume((progress) => {
            mainWindow.webContents.send('extraction-progress', progress);
        }, resumeMode);
        return { success: true, ...result };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('cancel-extraction', async () => {
    extractor.cancelExtraction();
    return { success: true };
});

ipcMain.handle('get-extraction-progress', async () => {
    try {
        const progress = extractor.getExtractionProgress();
        return { success: true, progress };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('cleanup-incomplete-sections', async () => {
    try {
        const cleanedCount = extractor.cleanupPartialExtractionSession();
        return { success: true, cleanedCount };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('validate-database', async () => {
    try {
        const validation = extractor.validateDatabaseIntegrity();
        return { success: true, validation };
    } catch (error) {
        return { success: false, error: error.message };
    }
});


ipcMain.handle('search-fulllines', async (event, query, language, section, limit) => {
    try {
        const results = extractor.search(query, language, section, limit);
        return { success: true, results };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('search-by-character', async (event, characterName, language, section, limit) => {
    try {
        const results = extractor.searchByCharacter(characterName, language, section, limit);
        return { success: true, results };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-characters', async (event, language) => {
    try {
        const characters = extractor.getUniqueCharacters(language);
        return { success: true, characters };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-stats', async () => {
    try {
        const stats = extractor.getStats();
        return { success: true, stats };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-database-path', () => {
    return extractor.dbPath;
});

ipcMain.handle('get-sections-status', () => {
    const result = extractor.loadSections();
    return result;
});

ipcMain.handle('get-log-file-path', () => {
    return extractor.logFilePath;
});

ipcMain.handle('get-database-summary', async () => {
    try {
        const summary = extractor.getDatabaseSummary();
        return { success: true, summary };
    } catch (error) {
        return { success: false, error: error.message };
    }
});