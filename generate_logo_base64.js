import fs from 'fs';
const logo = fs.readFileSync('C:\\h2know\\H2Know\\src\\assets\\img\\H2knowLogo.jpg');
const base64 = logo.toString('base64');
const dataUrl = 'data:image/png;base64,' + base64;  // File is actually PNG despite .jpg extension

// Format as a multi-line string for embedding in JS
const formatted = dataUrl.match(/.{1,80}/g).join('"\n  + "');
const jsConst = `const LOGO_BASE64 = "${formatted}";`;

fs.writeFileSync('C:\\h2know\\H2Know\\logo_js_const.txt', jsConst, 'utf8');
console.log('Written JS constant to file');
