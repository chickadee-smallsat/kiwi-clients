const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('plotlyClientMeta', {
  runtime: 'electron'
});
