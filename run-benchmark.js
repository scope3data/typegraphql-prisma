#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

async function runBenchmark() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(
      "Usage: node run-benchmark.js <schema-path> <output-dir> [iterations] [save-results]",
    );
    console.log("");
    console.log("Examples:");
    console.log("  node run-benchmark.js ./prisma/schema.prisma ./generated");
    console.log("  node run-benchmark.js ./prisma/schema.prisma ./generated 5");
    console.log(
      "  node run-benchmark.js ./prisma/schema.prisma ./generated 3 ./results.json",
    );
    console.log("");
    console.log("Options:");
    console.log("  schema-path   Path to your Prisma schema file");
    console.log(
      "  output-dir    Directory where generated files will be written",
    );
    console.log("  iterations    Number of benchmark iterations (default: 3)");
    console.log("  save-results  Path to save benchmark results as JSON");
    process.exit(1);
  }

  const [schemaPath, outputDir, iterations = "3", saveResults] = args;

  // Validate inputs
  if (!fs.existsSync(schemaPath)) {
    console.error(`❌ Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  // Ensure output directory parent exists
  const outputParent = path.dirname(outputDir);
  if (!fs.existsSync(outputParent)) {
    console.error(`❌ Output parent directory not found: ${outputParent}`);
    process.exit(1);
  }

  console.log("🚀 TypeGraphQL-Prisma Performance Benchmark");
  console.log("=".repeat(50));
  console.log(`📋 Configuration:`);
  console.log(`   Schema: ${path.resolve(schemaPath)}`);
  console.log(`   Output: ${path.resolve(outputDir)}`);
  console.log(`   Iterations: ${iterations}`);
  if (saveResults) {
    console.log(`   Save Results: ${path.resolve(saveResults)}`);
  }
  console.log("");

  // Build the project first
  console.log("📦 Building TypeGraphQL-Prisma...");
  try {
    await runCommand("npm", ["run", "build"], { stdio: "pipe" });
    console.log("✅ Build complete");
  } catch (error) {
    console.error("❌ Build failed:", error.message);
    process.exit(1);
  }

  // Run the benchmark
  console.log("⏱️  Starting benchmark...");
  const benchmarkArgs = [
    "--expose-gc", // Enable garbage collection for better memory measurements
    "./lib/benchmark.js",
    schemaPath,
    outputDir,
    iterations,
  ];

  if (saveResults) {
    benchmarkArgs.push(saveResults);
  }

  try {
    await runCommand("node", benchmarkArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: "--expose-gc",
      },
    });

    console.log("");
    console.log("✅ Benchmark completed successfully!");

    if (saveResults && fs.existsSync(saveResults)) {
      console.log(`📊 Results saved to: ${path.resolve(saveResults)}`);

      // Show quick summary
      try {
        const results = JSON.parse(fs.readFileSync(saveResults, "utf8"));
        const totalTime = results.results.find(
          r => r.name === "full-generation",
        )?.duration;
        if (totalTime) {
          console.log(`🏁 Total generation time: ${totalTime.toFixed(2)}ms`);
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
  } catch (error) {
    console.error("❌ Benchmark failed:", error.message);
    process.exit(1);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });

    child.on("error", error => {
      reject(error);
    });
  });
}

// Run if called directly
if (require.main === module) {
  runBenchmark().catch(console.error);
}
