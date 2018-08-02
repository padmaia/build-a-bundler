const fs = require('fs');
const path = require('path');

const cwd = process.cwd();

let srcTextPath = path.join(cwd, 'text.js')

let indexText = '';
for (let i = 0; i < 200; i++) {
  let oneMegabyteString = fs.readFileSync(srcTextPath, 'utf8');
  let fileText = "module.exports=`";
  for (let j = 0; j < 10; j++) {
    fileText += oneMegabyteString;
  }
  fileText += "`";
  fs.writeFileSync(path.join(cwd, `src/file${i}.js`), fileText)
  indexText += `import './file${i}'\n`;
}

fs.writeFileSync(path.join(cwd, 'src/index.js'), indexText);
