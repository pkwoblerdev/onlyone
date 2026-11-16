const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const code=fs.readFileSync(path.join(__dirname,'../build/installer.nsh'),'utf8').replace(/^\s*;.*$/gm,'');
assert(!/!macro\s+customUnInstallCheck/.test(code),'do not override the old-uninstaller error gate');
assert(!/!macro\s+customRemoveFiles/.test(code),'preserve transactional removal and rollback');
assert(!/RMDir[^\r\n]*\/REBOOTOK/i.test(code),'never schedule removal of the future installation path');
console.log('Installer safety: stock abort, rollback and no delayed directory deletion');
