import fs from "node:fs";
import path from "node:path";

import removeDir from "../../src/utils/removeDir";

async function setupTests() {
  const artifactsDirPath = path.join(__dirname, "../artifacts");

  if (fs.existsSync(artifactsDirPath)) {
    console.log("cleaning artifacts dir...");
    await removeDir(path.join(__dirname, "../artifacts"), true);
    console.log("cleaned!");
  }
}

setupTests()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
