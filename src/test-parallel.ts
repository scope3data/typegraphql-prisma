#!/usr/bin/env node

import { performance } from 'perf_hooks';

interface TestResult {
  name: string;
  duration: number;
  operations: number;
  avgPerOperation: number;
}

class ParallelizationTest {

  /**
   * Simulate the work done by generateEnumFromDef or similar functions
   */
  private async simulateWork(id: string, workTimeMs: number = 10): Promise<void> {
    const start = performance.now();

    // Simulate CPU-intensive work (like AST manipulation)
    while (performance.now() - start < workTimeMs) {
      // Busy wait to simulate work
      Math.random();
    }
  }

  /**
   * Test sequential processing
   */
  async testSequential(items: string[], workTimeMs: number = 10): Promise<TestResult> {
    const start = performance.now();

    for (const item of items) {
      await this.simulateWork(item, workTimeMs);
    }

    const duration = performance.now() - start;

    return {
      name: 'Sequential',
      duration,
      operations: items.length,
      avgPerOperation: duration / items.length
    };
  }

  /**
   * Test parallel processing
   */
  async testParallel(items: string[], workTimeMs: number = 10): Promise<TestResult> {
    const start = performance.now();

    const promises = items.map(item => this.simulateWork(item, workTimeMs));
    await Promise.all(promises);

    const duration = performance.now() - start;

    return {
      name: 'Parallel',
      duration,
      operations: items.length,
      avgPerOperation: duration / items.length
    };
  }

  /**
   * Test our instrumentation approach (similar to what we did in generate-code-instrumented)
   */
  async testInstrumentedParallel(items: string[], workTimeMs: number = 10): Promise<TestResult> {
    const start = performance.now();
    const individualTimings: number[] = [];

    const promises = items.map(async (item) => {
      const itemStart = performance.now();
      await this.simulateWork(item, workTimeMs);
      const itemEnd = performance.now();
      individualTimings.push(itemEnd - itemStart);
    });

    await Promise.all(promises);

    const totalDuration = performance.now() - start;
    const sumOfIndividualTimings = individualTimings.reduce((sum, t) => sum + t, 0);

    console.log(`    Individual timings sum: ${sumOfIndividualTimings.toFixed(2)}ms`);
    console.log(`    Total wall-clock time: ${totalDuration.toFixed(2)}ms`);
    console.log(`    Parallelization efficiency: ${((sumOfIndividualTimings / totalDuration) * 100).toFixed(1)}%`);

    return {
      name: 'Instrumented Parallel',
      duration: totalDuration,
      operations: items.length,
      avgPerOperation: totalDuration / items.length
    };
  }

  /**
   * Run comprehensive test
   */
  async runTest() {
    console.log('🧪 Testing Parallelization Effectiveness\n');

    // Test with different scenarios
    const testCases = [
      { name: '16 Enums (10ms each)', items: Array.from({length: 16}, (_, i) => `enum${i}`), workTime: 10 },
      { name: '30 Models (15ms each)', items: Array.from({length: 30}, (_, i) => `model${i}`), workTime: 15 },
      { name: '100 Inputs (5ms each)', items: Array.from({length: 100}, (_, i) => `input${i}`), workTime: 5 },
    ];

    for (const testCase of testCases) {
      console.log(`\n📊 Testing: ${testCase.name}`);
      console.log('-'.repeat(50));

      const sequential = await this.testSequential(testCase.items, testCase.workTime);
      const parallel = await this.testParallel(testCase.items, testCase.workTime);
      const instrumentedParallel = await this.testInstrumentedParallel(testCase.items, testCase.workTime);

      console.log(`Sequential:          ${sequential.duration.toFixed(2)}ms (${sequential.avgPerOperation.toFixed(2)}ms per item)`);
      console.log(`Parallel:            ${parallel.duration.toFixed(2)}ms (${parallel.avgPerOperation.toFixed(2)}ms per item)`);
      console.log(`Instrumented Parallel: ${instrumentedParallel.duration.toFixed(2)}ms (${instrumentedParallel.avgPerOperation.toFixed(2)}ms per item)`);

      const speedup = sequential.duration / parallel.duration;
      const efficiency = speedup / testCase.items.length;

      console.log(`\n🚀 Performance:`);
      console.log(`  Speedup: ${speedup.toFixed(2)}x`);
      console.log(`  Efficiency: ${(efficiency * 100).toFixed(1)}% (100% = perfect parallelization)`);
      console.log(`  Time saved: ${(sequential.duration - parallel.duration).toFixed(2)}ms`);
    }
  }

  /**
   * Test specifically what might be happening with our TypeScript compilation
   */
  async testTypeScriptLikeWorkload() {
    console.log('\n\n🔧 Testing TypeScript-like Workload\n');

    // Simulate what happens when ts-morph creates source files
    const simulateFileCreation = async (fileName: string, complexity: number = 50): Promise<void> => {
      const start = performance.now();

      // Simulate more realistic work patterns
      for (let i = 0; i < complexity; i++) {
        // Simulate AST node creation and manipulation
        const obj = {
          name: fileName,
          type: 'source-file',
          statements: [] as any[],
          imports: [] as any[],
          exports: [] as any[]
        };

        // Simulate adding statements
        for (let j = 0; j < 10; j++) {
          obj.statements.push({
            kind: 'statement',
            text: `statement_${j}`,
            pos: j
          });
        }

        // Small delay to simulate I/O or other async work
        await new Promise(resolve => setImmediate(resolve));
      }
    };

    const files = [
      'User.ts', 'UserProfile.ts', 'Address.ts', 'Category.ts', 'Product.ts',
      'ProductVariant.ts', 'Brand.ts', 'Vendor.ts', 'Inventory.ts', 'Warehouse.ts'
    ];

    console.log('Sequential file generation:');
    const seqStart = performance.now();
    for (const file of files) {
      await simulateFileCreation(file, 30);
    }
    const seqTime = performance.now() - seqStart;
    console.log(`  ${seqTime.toFixed(2)}ms total, ${(seqTime / files.length).toFixed(2)}ms per file`);

    console.log('\nParallel file generation:');
    const parStart = performance.now();
    await Promise.all(files.map(file => simulateFileCreation(file, 30)));
    const parTime = performance.now() - parStart;
    console.log(`  ${parTime.toFixed(2)}ms total, ${(parTime / files.length).toFixed(2)}ms per file`);

    console.log(`\n📈 File generation speedup: ${(seqTime / parTime).toFixed(2)}x`);
  }
}

// Main execution
async function main() {
  const test = new ParallelizationTest();

  await test.runTest();
  await test.testTypeScriptLikeWorkload();

  console.log('\n✅ Parallelization tests completed!');
  console.log('\n💡 Key Insights:');
  console.log('  - If parallel efficiency is low, the work might not be CPU-bound');
  console.log('  - If speedup is close to 1x, there might be synchronous bottlenecks');
  console.log('  - Check if ts-morph operations are internally synchronized');
}

if (require.main === module) {
  main().catch(console.error);
}
