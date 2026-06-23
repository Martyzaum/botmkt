const fileName = 'limpar-broadcast';
const fs = require('fs');

fs.writeFile(`${fileName}.js`, '', (err) => {
    if (err) throw err;
    console.log(`${fileName}.js created successfully.`);
});

const batContent = `@echo off
cd /d "%USERPROFILE%\\Desktop\\neymarlol-scripts"
node ${fileName}.js
cd /d "%USERPROFILE%\\Desktop"
echo.
pause`;
fs.writeFile(`${fileName}.bat`, batContent, (err) => {
    if (err) throw err;
    console.log(`${fileName}.bat created successfully.`);
});

