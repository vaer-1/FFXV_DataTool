const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectDatabaseLocation: () => ipcRenderer.invoke('select-database-location'),
    initializeDatabase: () => ipcRenderer.invoke('initialize-database'),
    getDatabasePath: () => ipcRenderer.invoke('get-database-path'),
    testConnection: () => ipcRenderer.invoke('test-connection'),
    startExtraction: () => ipcRenderer.invoke('start-extraction'),
    startExtractionWithResume: (resumeMode) => ipcRenderer.invoke('start-extraction-with-resume', resumeMode),
    cancelExtraction: () => ipcRenderer.invoke('cancel-extraction'),
    getExtractionProgress: () => ipcRenderer.invoke('get-extraction-progress'),
    cleanupIncompleteSections: () => ipcRenderer.invoke('cleanup-incomplete-sections'),
    validateDatabase: () => ipcRenderer.invoke('validate-database'),
    getDatabaseSummary: () => ipcRenderer.invoke('get-database-summary'),
    searchFullLines: (query, language, section, limit) => ipcRenderer.invoke('search-fulllines', query, language, section, limit),
    getCharacters: (language) => ipcRenderer.invoke('get-characters', language),
    searchByCharacter: (characterName, language, section, limit) => ipcRenderer.invoke('search-by-character', characterName, language, section, limit),
    getStats: () => ipcRenderer.invoke('get-stats'),
    getSectionsStatus: () => ipcRenderer.invoke('get-sections-status'),
    getLogFilePath: () => ipcRenderer.invoke('get-log-file-path'),
    onExtractionProgress: (callback) => {
        ipcRenderer.on('extraction-progress', (event, progress) => callback(progress));
    }
});