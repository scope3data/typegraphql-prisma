#!/bin/bash
START_TIME=$SECONDS

echo "Building package for distribution..."
rm -rf lib
rm -rf package
mkdir package

echo "Compiling TypeScript with production config..."
npx tsc -p tsconfig.build.json

echo "Copying files..."
# Copy the compiled lib directory (already excludes dev files due to tsconfig.build.json)
cp -r lib package/lib

# Copy essential root files only
cp package.json Readme.md LICENSE package/

echo "Setting executable permissions..."
chmod +x package/lib/generator.js

echo "Adjusting package.json..."
sed -i '' 's/"private": true/"private": false/' ./package/package.json
npm pkg delete scripts.prepare --prefix ./package

echo "Production build complete!"
echo "Excluded files via tsconfig.build.json:"
echo "  - *benchmarked* files"
echo "  - *backup* files"
echo "  - benchmark.* files"
echo "  - test-parallel.* files"
echo "  - test-schemas/ directory"

ELAPSED_TIME=$(($SECONDS - $START_TIME))
echo "Done in $ELAPSED_TIME seconds!"
