const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const axios = require('axios');

class FFXVExtractor {
    constructor() 
    {
        this.baseUrl = 'https://ff15.aikotoba.jp';
        this.dbPath = null;
        this.db = null;
        this.extractionCancelled = false;
        this.characterMappings = null;
        this.languages = 
        {
            'us': 'English',
            'jp': 'Japanese',
            'de': 'German',
            'fr': 'French'
        };

        this.loadSections();
        this.loadCharacterMappings();
        this.initializeLogFile();
        }
        
    buildUrl(section, langCode = null, isListFile = false) {
        const baseUrl = 'https://ff15.aikotoba.jp';
        
        // Base URL is the web view with hash fragment
        if (!langCode && !isListFile) {
            return `${baseUrl}/#/${section}`;
        }
        
        // Determine suffix for API endpoints
        let suffix = '';
        if (isListFile) {
            suffix = '_list';
        } else if (langCode) {
            suffix = `_${langCode}`;
        }

        if (section.startsWith('dir/')) {
            // Story sections: dir/16009story_v_cp00 -> /data/16009story_v_cp00_list.json
            const storyId = section.replace('dir/', '');
            return `${baseUrl}/data/${storyId}${suffix}.json`;
        } else if (section.startsWith('wiki/')) {
            // Wiki sections: wiki/enemy -> /wiki/wiki_enemy_list.json
            const wikiType = section.replace('wiki/', '');
            return `${baseUrl}/wiki/wiki_${wikiType}${suffix}.json`;
        } else {
            // Simple sections: nowloading -> /nowloading/nowloading_list.json
            return `${baseUrl}/${section}/${section}${suffix}.json`;
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
                const viewUrl = this.baseUrl + `/#/${sectionConfig.name}`;
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
            dialogue_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            section TEXT NOT NULL,
            language TEXT NOT NULL,
            lang_name TEXT NOT NULL,
            text TEXT NOT NULL,
            character_id TEXT,
            PRIMARY KEY (dialogue_id, language),
            FOREIGN KEY (conversation_id) REFERENCES SourceSubLabels(id)
        );
        
        CREATE TABLE IF NOT EXISTS SourceSubLabels (
            id TEXT PRIMARY KEY,
            section TEXT NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS character_mappings (
            character_id TEXT PRIMARY KEY,
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
        CREATE INDEX IF NOT EXISTS idx_fulllines_character_id ON fulllines(character_id);
        CREATE INDEX IF NOT EXISTS idx_fulllines_conversation_id ON fulllines(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_fulllines_dialogue_lang ON fulllines(dialogue_id, language);
        CREATE INDEX IF NOT EXISTS idx_sourcelabels_section ON SourceSubLabels(section);
        
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

    async _fetchWithRetry(url, filename, progressCallback, currentIndex, totalFiles, startingProgress) {
        try {
            progressCallback({
                current: currentIndex,
                total: totalFiles + startingProgress,
                currentFile: filename,
                status: 'downloading'
            });

            const response = await axios.get(url, { timeout: 15000 });
            this.consecutiveFailures = 0; // Reset on success
            
            const successMessage = `Downloaded ${filename}`;
            this.writeToLogFile(successMessage, 'SUCCESS');
            
            return { success: true, data: response.data };
            
        } catch (error) {
            this.consecutiveFailures++;
            
            if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                const errorMessage = `Operation cancelled: ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures detected. Last error: ${error.message}`;
                this.writeToLogFile(errorMessage, 'ERROR');
                progressCallback({
                    current: currentIndex,
                    total: totalFiles + startingProgress,
                    status: 'error',
                    error: errorMessage
                });
                throw new Error(errorMessage);
            }

            const errorMessage = `Failed ${filename}: ${error.message}`;
            this.writeToLogFile(errorMessage, 'ERROR');
            progressCallback({
                current: currentIndex,
                total: totalFiles + startingProgress,
                currentFile: filename,
                status: 'error',
                error: error.message
            });
            
            return { success: false, error: error.message };
        }
    }

    async extractDataWithResume(progressCallback, resumeMode = false) {
        this.extractionCancelled = false;
        let sectionsToProcess = [...this.sections];
        let startingProgress = 0;

        // Initialize retry tracking
        this.consecutiveFailures = 0;
        this.MAX_CONSECUTIVE_FAILURES = 3;

        // Handle resume mode: skip already completed sections
        if (resumeMode) {
            const progress = this.getExtractionProgress();
            
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
            return total + sectionConfig.languages.length + 1; // +1 for list file
        }, 0);
        
        let currentIndex = startingProgress;
        let successCount = 0;
        let failCount = 0;

        // Prepare database statements
        const insertFullLineStmt = this.db.prepare(`
            INSERT OR REPLACE INTO fulllines 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        const insertConversationStmt = this.db.prepare(`
            INSERT OR REPLACE INTO SourceSubLabels 
            VALUES (?, ?)
        `);

        // Store character mappings and section URLs once at the beginning
        await this.storeMetadataOnce(progressCallback);

        for (const sectionConfig of sectionsToProcess) {
            const sectionName = sectionConfig.name;
            
            if (this.extractionCancelled) {
                return this.handleCancellation(currentIndex, totalFiles, startingProgress, successCount, failCount);
            }

            try {
                const sectionResult = await this.processSingleSection(
                    sectionConfig, 
                    insertFullLineStmt, 
                    insertConversationStmt, 
                    progressCallback, 
                    currentIndex, 
                    totalFiles, 
                    startingProgress
                );

                currentIndex = sectionResult.newIndex;
                successCount += sectionResult.successCount;
                failCount += sectionResult.failCount;

            } catch (error) {
                this.writeToLogFile(`Section ${sectionName} failed completely: ${error.message}`, 'ERROR');
                
                // Skip all files for this section
                const skippedFiles = sectionConfig.languages.length + 1;
                currentIndex += skippedFiles;
                failCount += skippedFiles;
            }
        }

        const completionMessage = `Extraction completed. Success: ${successCount}, Failed: ${failCount}`;
        this.writeToLogFile(completionMessage, 'INFO');
        return { successCount, failCount, cancelled: false };
    }

    async storeMetadataOnce(progressCallback) {
        // Store character mappings once if available
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
    }

    async processSingleSection(sectionConfig, insertFullLineStmt, insertConversationStmt, progressCallback, currentIndex, totalFiles, startingProgress) {
        const sectionName = sectionConfig.name;
        let localSuccessCount = 0;
        let localFailCount = 0;
        let localIndex = currentIndex;

        // Step 1: Validate section exists with base manifest
        const baseUrl = this.buildUrl(sectionName);
        const baseResult = await this._fetchWithRetry(baseUrl, `${sectionName} (base)`, progressCallback, localIndex, totalFiles, startingProgress);
        
        if (!baseResult.success) {
            const skippedFiles = sectionConfig.languages.length + 1;
            return {
                newIndex: localIndex + skippedFiles,
                successCount: 0,
                failCount: skippedFiles
            };
        }

        // Step 2: Fetch conversation list for character mappings
        localIndex++;
        const listUrl = this.buildUrl(sectionName, null, true);
        const listResult = await this._fetchWithRetry(listUrl, `${sectionName}_list.json`, progressCallback, localIndex, totalFiles, startingProgress);
        
        if (!listResult.success) {
            const skippedFiles = sectionConfig.languages.length;
            return {
                newIndex: localIndex + skippedFiles,
                successCount: 0,
                failCount: skippedFiles
            };
        }

        const conversationData = listResult.data;
        localSuccessCount++;

        // Store conversation metadata
        try {
            const conversationTransaction = this.db.transaction(() => {
                for (const conversation of conversationData) {
                    insertConversationStmt.run(conversation.id, sectionName);
                }
            });
            conversationTransaction();

            progressCallback({
                current: localIndex,
                total: totalFiles + startingProgress,
                currentFile: `${sectionName}_list.json`,
                status: 'success',
                entryCount: conversationData.length
            });
        } catch (error) {
            this.writeToLogFile(`Failed to store conversations for ${sectionName}: ${error.message}`, 'ERROR');
        }

        // Step 3: Create lookup maps for character and conversation IDs
        const { dialogueToCharacter, dialogueToConversation } = this.createLookupMaps(conversationData);

        // Step 4: Process each language file
        for (const langCode of sectionConfig.languages) {
            if (this.extractionCancelled) {
                return this.handleCancellation(localIndex, totalFiles, startingProgress, localSuccessCount, localFailCount);
            }

            localIndex++;
            const result = await this.processLanguageFile(
                sectionName, 
                langCode, 
                dialogueToCharacter, 
                dialogueToConversation, 
                insertFullLineStmt, 
                progressCallback, 
                localIndex, 
                totalFiles, 
                startingProgress
            );

            if (result.success) {
                localSuccessCount++;
            } else {
                localFailCount++;
            }

            // Respectful delay between requests
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        return {
            newIndex: localIndex,
            successCount: localSuccessCount,
            failCount: localFailCount
        };
    }

    createLookupMaps(conversationData) {
        const dialogueToCharacter = new Map();
        const dialogueToConversation = new Map();
        
        if (conversationData) {
            for (const conversation of conversationData) {
                for (const line of conversation.lines) {
                    dialogueToCharacter.set(line.id, line.chara);
                    dialogueToConversation.set(line.id, conversation.id);
                }
            }
        }

        return { dialogueToCharacter, dialogueToConversation };
    }

    async processLanguageFile(sectionName, langCode, dialogueToCharacter, dialogueToConversation, insertFullLineStmt, progressCallback, currentIndex, totalFiles, startingProgress) {
        const url = this.buildUrl(sectionName, langCode);
        const currentFileName = `${sectionName}_${langCode}.json`;
        const langName = this.languages[langCode];
        
        const result = await this._fetchWithRetry(url, currentFileName, progressCallback, currentIndex, totalFiles, startingProgress);
        
        if (!result.success) {
            return { success: false };
        }

        const data = result.data;
        
        try {
            // Insert all entries in a single transaction
            const transaction = this.db.transaction(() => {
                for (const [dialogueId, text] of Object.entries(data)) {
                    const characterId = dialogueToCharacter.get(dialogueId) || null;
                    const conversationId = dialogueToConversation.get(dialogueId) || null;
                    
                    insertFullLineStmt.run(
                        dialogueId,
                        conversationId,
                        sectionName,
                        langCode,
                        langName,
                        text,
                        characterId
                    );
                }
            });

            transaction();
            
            progressCallback({
                current: currentIndex,
                total: totalFiles + startingProgress,
                currentFile: currentFileName,
                status: 'success',
                entryCount: Object.keys(data).length
            });

            return { success: true };

        } catch (error) {
            this.writeToLogFile(`Database error for ${currentFileName}: ${error.message}`, 'ERROR');
            return { success: false };
        }
    }

    handleCancellation(currentIndex, totalFiles, startingProgress, successCount, failCount) {
        const cancelMessage = 'Extraction cancelled by user';
        this.writeToLogFile(cancelMessage, 'INFO');
        return { successCount, failCount, cancelled: true };
    }
    search(query, language = null, section = null, limit = null) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        if (!query || typeof query !== 'string') {
            throw new Error('Query parameter is required and must be a string');
        }

        const sql = this._buildSearchSql(false, language, section, limit);
        const params = [`%${query}%`];
        
        if (language) params.push(language);
        if (section) params.push(section);

        const stmt = this.db.prepare(sql);
        const results = stmt.all(...params);

        return results.map(row => ({
            dialogueId: row.dialogue_id,
            conversationId: row.conversation_id,
            section: row.section,
            language: row.language,
            langName: row.lang_name,
            text: row.text,
            characterId: row.character_id,
            speakerName: row.speaker_name || 'Unknown',
            sectionUrl: row.view_url || `https://ff15.aikotoba.jp/#/${row.section}`
        }));
    }

    searchByCharacter(characterName, language = null, section = null, limit = null) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        if (!characterName || typeof characterName !== 'string') {
            throw new Error('Character name parameter is required and must be a string');
        }

        const sql = this._buildSearchSql(true, language, section, limit);
        const params = [characterName];
        
        if (language) params.push(language);
        if (section) params.push(section);

        const stmt = this.db.prepare(sql);
        const results = stmt.all(...params);

        return results.map(row => ({
            dialogueId: row.dialogue_id,
            conversationId: row.conversation_id,
            section: row.section,
            language: row.language,
            langName: row.lang_name,
            text: row.text,
            characterId: row.character_id,
            speakerName: row.speaker_name || characterName,
            sectionUrl: row.view_url || `https://ff15.aikotoba.jp/#/${row.section}`
        }));
    }

    _buildSearchSql(isCharacterSearch = false, language = null, section = null, limit = null) 
    {
        let sql = `
            SELECT f.*, 
                CASE f.language
                    WHEN 'us' THEN c.us_name
                    WHEN 'jp' THEN c.jp_name  
                    WHEN 'de' THEN c.de_name
                    WHEN 'fr' THEN c.fr_name
                    ELSE '???'
                END as speaker_name,
                u.view_url
            FROM fulllines f 
            ${isCharacterSearch ? 'JOIN' : 'LEFT JOIN'} character_mappings c ON f.character_id = c.character_id
            LEFT JOIN section_urls u ON f.section = u.section_name
            WHERE `;

        if (isCharacterSearch) 
        {
            sql += `CASE f.language
                        WHEN 'us' THEN c.us_name
                        WHEN 'jp' THEN c.jp_name  
                        WHEN 'de' THEN c.de_name
                        WHEN 'fr' THEN c.fr_name
                        ELSE c.us_name
                    END = ?`;
        } 
        else 
        {
            sql += `LOWER(f.text) LIKE LOWER(?)`;
        }

        if (language)
            sql += ' AND f.language = ?';
        if (section)
            sql += ' AND f.section = ?';

        sql += ` ORDER BY f.section, f.language`;
        if (limit && limit > 0)
            sql += ` LIMIT ${limit}`;
        return sql;
    }

    getUniqueCharacters(language = null) {
        if (!this.db)
            throw new Error('Database not initialized');

        let sql, params = [];

        if (language) 
        {
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
            ORDER BY character_name`;
            params = [language, language];
        } 
        else 
        {
            // Get all unique characters (use US names as default)
            sql = `
            SELECT DISTINCT c.us_name as character_name
            FROM character_mappings c
            WHERE c.us_name IS NOT NULL
            ORDER BY character_name`;
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
            for (const [characterId, characterData] of Object.entries(this.characterMappings)) {
                insertStmt.run(
                    characterId,
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
        icon: path.join(__dirname, 'assets/icon.ico'),
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