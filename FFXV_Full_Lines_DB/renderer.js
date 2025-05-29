class FFXVExtractorUI {
    constructor() {
        this.isExtracting = false;
        this.databaseSelected = false;
        this.extractionComplete = false;
        this.resumeAvailable = false;
        this.sectionsError = false;

        this.initializeElements();
        this.attachEventListeners();
        this.updateUI();
    }

    initializeElements() {
        // Database setup
        this.selectLocationBtn = document.getElementById('select-location-btn');
        this.setupInfo = document.getElementById('setup-info');
        this.dbPath = document.getElementById('db-path');

        // Extraction controls
        this.extractBtn = document.getElementById('extract-btn');
        this.resumeBtn = document.getElementById('resume-btn');
        this.cancelBtn = document.getElementById('cancel-btn');

        // Progress
        this.progressContainer = document.getElementById('progress-container');
        this.progressText = document.getElementById('progress-text');
        this.progressPercent = document.getElementById('progress-percent');
        this.progressFill = document.getElementById('progress-fill');
        this.currentFile = document.getElementById('current-file');
        this.progressInfo = document.getElementById('progress-info');

        // Maintenance controls
        this.cleanupBtn = document.getElementById('cleanup-btn');
        this.validateBtn = document.getElementById('validate-btn');

        // Stats and logs
        this.statsPanel = document.getElementById('stats-panel');
        this.statsContent = document.getElementById('stats-content');
        this.logContainer = document.getElementById('log-container');
        this.status = document.getElementById('status');

        // Search
        this.searchInput = document.getElementById('search-input');
        this.languageFilter = document.getElementById('language-filter');
        this.sectionFilter = document.getElementById('section-filter');
        this.speakerFilter = document.getElementById('speaker-filter');
        this.searchBtn = document.getElementById('search-btn');
        this.resultsList = document.getElementById('results-list');
        this.resultsCount = document.getElementById('results-count');
    }

    attachEventListeners() {
        this.selectLocationBtn.addEventListener('click', () => this.selectDatabaseLocation());
        this.extractBtn.addEventListener('click', () => this.startExtraction());
        this.resumeBtn?.addEventListener('click', () => this.resumeExtraction());
        this.cancelBtn.addEventListener('click', () => this.cancelExtraction());
        this.cleanupBtn?.addEventListener('click', () => this.cleanupIncompleteData());
        this.validateBtn?.addEventListener('click', () => this.validateDatabase());
        this.searchBtn.addEventListener('click', () => this.performSearch());

        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.performSearch();
        });

        this.searchInput.addEventListener('input', () => {
            if (this.searchInput.value.length >= 3) {
                this.performSearch();
            }
        });

        this.languageFilter.addEventListener('change', () => {
            this.populateSpeakerFilter();
            this.performSearch();
        });

        this.sectionFilter.addEventListener('change', () => this.performSearch());
        this.speakerFilter.addEventListener('change', () => this.performSearch());

        // Listen for extraction progress
        window.electronAPI.onExtractionProgress((progress) => {
            this.handleExtractionProgress(progress);
        });
    }

    async checkExtractionProgress() {
        if (!this.databaseSelected) return;

        const result = await window.electronAPI.getExtractionProgress();
        if (result.success) {
            const progress = result.progress;
            this.resumeAvailable = progress.remaining > 0;

            // Enable search if there's ANY extracted data
            this.extractionComplete = progress.hasAnyData && progress.completed > 0;

            if (progress.completed > 0) {
                const infoText = `Progress: ${progress.completed}/${progress.total} sections complete`;
                if (this.progressInfo) {
                    this.progressInfo.textContent = infoText;
                    this.progressInfo.style.display = 'block';
                }
                this.addLog(infoText, 'info');

                if (this.extractionComplete) {
                    this.addLog('Database has extracted data - enabling search functionality', 'success');
                    await this.loadStats();
                    await this.populateSectionFilter();
                    await this.populateSpeakerFilter();
                }
            }

            this.updateUI();
        }
    }

    async selectDatabaseLocation() {
        // Check sections status first
        const sectionsResult = await window.electronAPI.getSectionsStatus();
        if (!sectionsResult.success) {
            this.addLog('Sections configuration error: ' + sectionsResult.error, 'error');
            this.setStatus('Configuration error', 'error');
            this.sectionsError = true;
            this.updateUI();
            return;
        }

        const result = await window.electronAPI.selectDatabaseLocation();
        if (result.success && result.path) {
            this.databaseSelected = true;
            this.dbPath.textContent = result.path;
            this.setupInfo.style.display = 'block';
            this.addLog('Database location selected: ' + result.path, 'info');

            const initResult = await window.electronAPI.initializeDatabase();
            if (initResult.success) {
                this.addLog('Database initialized successfully', 'success');

                // Check if database has existing data
                const summaryResult = await window.electronAPI.getDatabaseSummary();
                if (summaryResult.success && summaryResult.summary.hasData) {
                    this.addLog(`Existing database loaded with ${summaryResult.summary.totalEntries.toLocaleString()} entries`, 'success');
                }

                await this.checkExtractionProgress();
                this.updateUI();
            } else {
                this.addLog('Failed to initialize database: ' + initResult.error, 'error');
            }
        }
    }

    async startExtraction() {
        if (!this.databaseSelected) {
            this.addLog('Please select database location first', 'error');
            return;
        }

        await this.performExtraction(false); // Fresh extraction
    }

    async resumeExtraction() {
        if (!this.databaseSelected || !this.resumeAvailable) {
            this.addLog('Resume not available', 'error');
            return;
        }

        await this.performExtraction(true); // Resume extraction
    }

    async performExtraction(resumeMode = false) {
        this.isExtracting = true;
        this.updateUI();

        const actionText = resumeMode ? 'Resuming extraction' : 'Starting extraction';
        this.setStatus('Testing connection...', 'testing');

        // Test connection first
        const connectionTest = await window.electronAPI.testConnection();
        if (!connectionTest.success) {
            this.addLog('Connection test failed. Please check internet connection.', 'error');
            this.isExtracting = false;
            this.setStatus('Connection failed', 'error');
            this.updateUI();
            return;
        }

        this.addLog(`Connection test passed. ${actionText}...`, 'success');
        this.setStatus(actionText, 'running');
        this.progressContainer.style.display = 'block';

        const result = await window.electronAPI.startExtractionWithResume(resumeMode);

        this.isExtracting = false;
        this.progressContainer.style.display = 'none';

        if (result.success) {
            if (result.cancelled) {
                this.addLog('Extraction cancelled by user', 'info');
                this.setStatus('Cancelled', 'cancelled');
            } else {
                this.extractionComplete = true;
                this.resumeAvailable = false;
                this.addLog(`Extraction complete. Success: ${result.successCount}, Failed: ${result.failCount}`, 'success');
                this.setStatus('Extraction complete', 'complete');
                await this.loadStats();
                this.populateSectionFilter();
                this.populateSpeakerFilter();
            }
        } else {
            this.addLog('Extraction failed: ' + result.error, 'error');
            this.setStatus('Extraction failed', 'error');

            // Check if we can resume after failure
            await this.checkExtractionProgress();
        }

        this.updateUI();
    }

    async cancelExtraction() {
        if (this.isExtracting) {
            await window.electronAPI.cancelExtraction();
            this.addLog('Cancellation requested...', 'info');
        }
    }

    async cleanupIncompleteData() {
        if (!this.databaseSelected) {
            this.addLog('Please select database first', 'error');
            return;
        }

        this.addLog('Cleaning up incomplete sections...', 'info');
        const result = await window.electronAPI.cleanupIncompleteSections();

        if (result.success) {
            if (result.cleanedCount > 0) {
                this.addLog(`Cleaned up ${result.cleanedCount} incomplete sections`, 'success');
            } else {
                this.addLog('No incomplete sections found to clean up', 'info');
            }
            await this.checkExtractionProgress();
        } else {
            this.addLog('Cleanup failed: ' + result.error, 'error');
        }
    }

    async validateDatabase() {
        if (!this.databaseSelected) {
            this.addLog('Please select database first', 'error');
            return;
        }

        this.addLog('Validating database integrity...', 'info');
        const result = await window.electronAPI.validateDatabase();

        if (result.success) {
            const validation = result.validation;
            if (validation.isValid) {
                this.addLog('Database validation passed - no issues found', 'success');
            } else {
                validation.issues.forEach(issue => {
                    if (issue.type === 'incomplete_sections') {
                        this.addLog(`Found ${issue.count} incomplete sections`, 'warning');
                        issue.sections.forEach(sec => {
                            this.addLog(`  - ${sec.section}: missing ${sec.missingLanguages.join(', ')}`, 'warning');
                        });
                    } else if (issue.type === 'duplicates') {
                        this.addLog(`Found ${issue.count} duplicate entries`, 'warning');
                    }
                });
            }
        } else {
            this.addLog('Database validation failed: ' + result.error, 'error');
        }
    }

    async populateSpeakerFilter() {
        // Clear existing options except the first one (All Speakers)
        while (this.speakerFilter.children.length > 1) {
            this.speakerFilter.removeChild(this.speakerFilter.lastChild);
        }

        if (!this.extractionComplete) return;

        try {
            const currentLanguage = this.languageFilter.value || null;
            const result = await window.electronAPI.getCharacters(currentLanguage);

            if (result.success && result.characters) {
                // Debug log
                console.log(`Loaded ${result.characters.length} characters for language: ${currentLanguage || 'all'}`);

                result.characters.forEach(character => {
                    if (character && character.trim()) { // Skip empty names
                        const option = document.createElement('option');
                        option.value = character;
                        option.textContent = character;
                        this.speakerFilter.appendChild(option);
                    }
                });

                this.addLog(`Loaded ${result.characters.length} speakers for dropdown`, 'info');
            } else {
                this.addLog('Failed to load speakers: ' + (result.error || 'No characters found'), 'warning');
            }
        } catch (error) {
            console.error('Failed to populate speaker filter:', error);
            this.addLog('Error loading speakers: ' + error.message, 'error');
        }
    }

    async performSearch() {
        if (!this.extractionComplete) {
            this.clearResults();
            return;
        }

        const query = this.searchInput.value.trim();
        const language = this.languageFilter.value || null;
        const section = this.sectionFilter.value || null;
        const speaker = this.speakerFilter.value || null;

        // If no query but speaker is selected, search by speaker
        if (!query && speaker) {
            // Remove limit - search returns all results
            const result = await window.electronAPI.searchByCharacter(speaker, language, section, null);
            if (result.success) {
                this.displayResults(result.results, speaker, 'speaker');
            } else {
                this.addLog('Speaker search failed: ' + result.error, 'error');
            }
            return;
        }

        if (!query) {
            this.clearResults();
            return;
        }

        const result = await window.electronAPI.searchByCharacter(speaker, language, section, null);
        if (result.success) {
            // Filter by speaker if selected
            let results = result.results;
            if (speaker) {
                results = results.filter(r => r.speakerName === speaker);
            }
            this.displayResults(results, query, 'text');
        } else {
            this.addLog('Search failed: ' + result.error, 'error');
        }
    }

    displayResults(results, query, searchType = 'text') {
        this.resultsCount.textContent = `Search Results (${results.length.toLocaleString()})`;

        if (results.length === 0) {
            this.resultsList.innerHTML = '<div class="no-results">No results found</div>';
            return;
        }

        // Debug logging for character mapping issues
        const speakerStats = {};
        results.forEach(result => {
            const speaker = result.speakerName || '???';
            speakerStats[speaker] = (speakerStats[speaker] || 0) + 1;
        });
        console.log('Speaker distribution in results:', speakerStats);

        const resultsHTML = results.map(result => {
            const highlightedText = searchType === 'text' ?
                this.highlightText(result.text, query) : result.text;

            // Clean section name and create clickable link  
            const cleanSection = result.section.replace(/^dir\//, '');
            const sectionLink = `<a href="${result.sectionUrl}" target="_blank" class="section-link">${cleanSection}</a>`;

            return `
            <div class="result-item">
                <div class="result-meta">
                    <span>${sectionLink} • ${result.langName}</span>
                    <span class="speaker-name">${result.speakerName}</span>
                </div>
                <div class="result-text">${highlightedText}</div>
            </div>
        `;
        }).join('');

        this.resultsList.innerHTML = resultsHTML;

        // Log search statistics
        this.addLog(`Search returned ${results.length.toLocaleString()} results`, 'info');
    }

    highlightText(text, query) {
        if (!query) return text;
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(regex, '<strong style="background-color: #ffeb3b;">$1</strong>');
    }

    clearResults() {
        this.resultsCount.textContent = 'Search Results';
        this.resultsList.innerHTML = '<div class="no-results">Complete extraction to search full lines</div>';
    }

    async loadStats() {
        const result = await window.electronAPI.getStats();
        if (result.success) {
            this.displayStats(result.stats);
        }
    }

    displayStats(stats) {
        const statsHTML = `
            <div><strong>Total entries:</strong> ${stats.totalEntries.toLocaleString()}</div>
            <div><strong>Languages:</strong> ${Object.keys(stats.languages).length}</div>
            <div><strong>Sections:</strong> ${Object.keys(stats.sections).length}</div>
            <div style="margin-top: 8px; font-size: 11px;">
                ${Object.entries(stats.languages).map(([code, info]) =>
            `${info.name}: ${info.count.toLocaleString()}`
        ).join('<br>')}
            </div>
        `;
        this.statsContent.innerHTML = statsHTML;
        this.statsPanel.style.display = 'block';
    }

    async populateSectionFilter() {
        while (this.sectionFilter.children.length > 1) {
            this.sectionFilter.removeChild(this.sectionFilter.lastChild);
        }

        try {
            const result = await window.electronAPI.getStats();
            if (result.success && result.stats.sections) {
                const sections = Object.keys(result.stats.sections).sort();

                sections.forEach(section => {
                    const option = document.createElement('option');
                    option.value = section;
                    option.textContent = section;
                    this.sectionFilter.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Failed to populate section filter:', error);
            const commonSections = [
                'nowloading', 'story_v_cp01', 'story_v_cp02', 'ai_noct', 'ai_prompto',
                'ai_gladio', 'ai_ignis', 'battle_noct', 'battle_party', 'town_common'
            ];
            commonSections.forEach(section => {
                const option = document.createElement('option');
                option.value = section;
                option.textContent = section;
                this.sectionFilter.appendChild(option);
            });
        }
    }

    handleExtractionProgress(progress) {
        if (progress.status === 'cancelled') {
            return;
        }

        // Handle new progress types
        if (progress.status === 'cleanup') {
            this.addLog(progress.message, 'info');
            return;
        }

        if (progress.status === 'resume') {
            this.addLog(progress.message, 'info');
            return;
        }

        if (progress.status === 'info') {
            this.addLog(progress.message, 'info');
            return;
        }

        // Existing progress handling
        if (progress.total && progress.current !== undefined) {
            const percent = Math.round((progress.current / progress.total) * 100);
            this.progressText.textContent = `${progress.current} / ${progress.total}`;
            this.progressPercent.textContent = `${percent}%`;
            this.progressFill.style.width = `${percent}%`;
        }

        if (progress.currentFile) {
            this.currentFile.textContent = `Current: ${progress.currentFile}`;
        }

        if (progress.status === 'success' && progress.entryCount) {
            this.addLog(`Downloaded ${progress.currentFile} (${progress.entryCount} entries)`, 'success');
        } else if (progress.status === 'error') {
            this.addLog(`Failed ${progress.currentFile}: ${progress.error}`, 'error');
        } else if (progress.status === 'downloading') {
            // Just update UI, don't log every download attempt
        }
    }

    setStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `status-${type}`;
    }

    addLog(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `[${timestamp}] ${message}`;

        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;

        // Keep only last 100 entries
        while (this.logContainer.children.length > 100) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }
    }

    updateUI() {
        // Enable/disable extraction controls based on state
        this.extractBtn.disabled = !this.databaseSelected || this.isExtracting || this.sectionsError;
        this.cancelBtn.disabled = !this.isExtracting;

        if (this.resumeBtn) {
            this.resumeBtn.disabled = !this.databaseSelected || this.isExtracting || !this.resumeAvailable || this.sectionsError;
        }

        if (this.cleanupBtn) {
            this.cleanupBtn.disabled = !this.databaseSelected || this.isExtracting;
        }

        if (this.validateBtn) {
            this.validateBtn.disabled = !this.databaseSelected || this.isExtracting;
        }

        // Search controls - all three dropdowns
        const searchEnabled = this.extractionComplete && !this.isExtracting;
        this.searchInput.disabled = !searchEnabled;
        this.languageFilter.disabled = !searchEnabled;
        this.sectionFilter.disabled = !searchEnabled;
        this.speakerFilter.disabled = !searchEnabled;
        this.searchBtn.disabled = !searchEnabled;

        if (!searchEnabled) {
            this.clearResults();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new FFXVExtractorUI();
});