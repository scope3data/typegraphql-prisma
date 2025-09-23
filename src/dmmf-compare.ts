#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { getDMMF } from '@prisma/internals';
import { Command } from 'commander';

interface DMMFStats {
  models: number;
  enums: number;
  inputTypesPrisma: number;
  inputTypesModel: number;
  outputTypesPrisma: number;
  outputTypesModel: number;
  totalInputTypes: number;
  totalOutputTypes: number;
  complexityScore: number;
}

function analyzeDMMF(dmmf: any, label: string): DMMFStats {
  const models = dmmf.datamodel.models.length;
  const enums = dmmf.datamodel.enums.length;
  const inputTypesPrisma = dmmf.schema.inputObjectTypes.prisma?.length || 0;
  const inputTypesModel = dmmf.schema.inputObjectTypes.model?.length || 0;
  const outputTypesPrisma = dmmf.schema.outputObjectTypes.prisma.length;
  const outputTypesModel = dmmf.schema.outputObjectTypes.model.length;
  const totalInputTypes = inputTypesPrisma + inputTypesModel;
  const totalOutputTypes = outputTypesPrisma + outputTypesModel;
  const complexityScore = models * 10 + enums * 2 + totalInputTypes * 1 + totalOutputTypes * 3;

  const stats = {
    models,
    enums,
    inputTypesPrisma,
    inputTypesModel,
    outputTypesPrisma,
    outputTypesModel,
    totalInputTypes,
    totalOutputTypes,
    complexityScore,
  };

  console.log(`\n📊 ${label} DMMF Analysis:`);
  console.log(`  Models: ${models}`);
  console.log(`  Enums: ${enums}`);
  console.log(`  Input Types (prisma): ${inputTypesPrisma}`);
  console.log(`  Input Types (model): ${inputTypesModel}`);
  console.log(`  Total Input Types: ${totalInputTypes}`);
  console.log(`  Output Types (prisma): ${outputTypesPrisma}`);
  console.log(`  Output Types (model): ${outputTypesModel}`);
  console.log(`  Total Output Types: ${totalOutputTypes}`);
  console.log(`  Complexity Score: ${complexityScore}`);

  return stats;
}

function compareStats(benchmark: DMMFStats, production: DMMFStats): void {
  console.log(`\n🔍 DMMF Comparison:`);
  console.log(`  Models: ${benchmark.models} vs ${production.models} (${production.models - benchmark.models > 0 ? '+' : ''}${production.models - benchmark.models})`);
  console.log(`  Enums: ${benchmark.enums} vs ${production.enums} (${production.enums - benchmark.enums > 0 ? '+' : ''}${production.enums - benchmark.enums})`);
  console.log(`  Total Input Types: ${benchmark.totalInputTypes} vs ${production.totalInputTypes} (${production.totalInputTypes - benchmark.totalInputTypes > 0 ? '+' : ''}${production.totalInputTypes - benchmark.totalInputTypes})`);
  console.log(`  Total Output Types: ${benchmark.totalOutputTypes} vs ${production.totalOutputTypes} (${production.totalOutputTypes - benchmark.totalOutputTypes > 0 ? '+' : ''}${production.totalOutputTypes - benchmark.totalOutputTypes})`);
  console.log(`  Complexity Score: ${benchmark.complexityScore} vs ${production.complexityScore} (${production.complexityScore - benchmark.complexityScore > 0 ? '+' : ''}${production.complexityScore - benchmark.complexityScore})`);

  // Calculate percentage differences
  const inputTypeDiff = ((production.totalInputTypes - benchmark.totalInputTypes) / benchmark.totalInputTypes * 100);
  const outputTypeDiff = ((production.totalOutputTypes - benchmark.totalOutputTypes) / benchmark.totalOutputTypes * 100);
  const complexityDiff = ((production.complexityScore - benchmark.complexityScore) / benchmark.complexityScore * 100);

  console.log(`\n📈 Percentage Differences:`);
  console.log(`  Input Types: ${inputTypeDiff.toFixed(1)}%`);
  console.log(`  Output Types: ${outputTypeDiff.toFixed(1)}%`);
  console.log(`  Complexity: ${complexityDiff.toFixed(1)}%`);

  if (Math.abs(inputTypeDiff) > 5 || Math.abs(outputTypeDiff) > 5) {
    console.log(`\n⚠️  Significant differences detected! This could explain performance gaps.`);
  } else {
    console.log(`\n✅ DMMF structures are very similar. Performance difference likely elsewhere.`);
  }
}

async function comparePreviewFeatures(schemaPath: string): Promise<void> {
  console.log(`\n🧪 Comparing DMMF with and without preview features:`);

  const schemaContent = await fs.readFile(schemaPath, 'utf-8');

  // Parse preview features from schema
  const previewFeatureMatch = schemaContent.match(/previewFeatures\s*=\s*\[(.*?)\]/s);
  const previewFeatures = previewFeatureMatch
    ? previewFeatureMatch[1]
        .split(',')
        .map(f => f.trim().replace(/['"]/g, ''))
        .filter(f => f.length > 0)
    : [];

  console.log(`  Found preview features: ${previewFeatures.length > 0 ? previewFeatures.join(', ') : 'none'}`);

  // Generate DMMF without preview features (benchmark style)
  console.log(`\n⏱️  Generating benchmark-style DMMF...`);
  const benchmarkStart = performance.now();
  const benchmarkDmmf = await getDMMF({
    datamodel: schemaContent,
  });
  const benchmarkTime = performance.now() - benchmarkStart;
  console.log(`  Benchmark DMMF generation: ${benchmarkTime.toFixed(2)}ms`);

  // Generate DMMF with preview features (production style)
  console.log(`\n⏱️  Generating production-style DMMF...`);
  const productionStart = performance.now();
  const productionDmmf = await getDMMF({
    datamodel: schemaContent,
    previewFeatures,
  });
  const productionTime = performance.now() - productionStart;
  console.log(`  Production DMMF generation: ${productionTime.toFixed(2)}ms`);

  console.log(`\n⚡ DMMF Generation Time Difference: ${(productionTime - benchmarkTime).toFixed(2)}ms`);

  // Analyze both DMMF structures
  const benchmarkStats = analyzeDMMF(benchmarkDmmf, 'Benchmark');
  const productionStats = analyzeDMMF(productionDmmf, 'Production');

  // Compare them
  compareStats(benchmarkStats, productionStats);

  // Deep analysis of specific type differences
  console.log(`\n🔬 Deep Analysis:`);

  // Check for additional input types
  const benchmarkInputTypeNames = new Set([
    ...(benchmarkDmmf.schema.inputObjectTypes.prisma || []).map((t: any) => t.name),
    ...(benchmarkDmmf.schema.inputObjectTypes.model || []).map((t: any) => t.name)
  ]);

  const productionInputTypeNames = new Set([
    ...(productionDmmf.schema.inputObjectTypes.prisma || []).map((t: any) => t.name),
    ...(productionDmmf.schema.inputObjectTypes.model || []).map((t: any) => t.name)
  ]);

  const extraInputTypes = [...productionInputTypeNames].filter(name => !benchmarkInputTypeNames.has(name));
  const missingInputTypes = [...benchmarkInputTypeNames].filter(name => !productionInputTypeNames.has(name));

  if (extraInputTypes.length > 0) {
    console.log(`  Extra input types in production (first 10): ${extraInputTypes.slice(0, 10).join(', ')}`);
    if (extraInputTypes.length > 10) {
      console.log(`    ... and ${extraInputTypes.length - 10} more`);
    }
  }

  if (missingInputTypes.length > 0) {
    console.log(`  Missing input types in production (first 10): ${missingInputTypes.slice(0, 10).join(', ')}`);
    if (missingInputTypes.length > 10) {
      console.log(`    ... and ${missingInputTypes.length - 10} more`);
    }
  }

  // Estimate performance impact
  if (productionStats.totalInputTypes > benchmarkStats.totalInputTypes) {
    const extraInputs = productionStats.totalInputTypes - benchmarkStats.totalInputTypes;
    const estimatedExtraTime = (extraInputs / benchmarkStats.totalInputTypes) * 52000; // Based on 52s baseline
    console.log(`\n⚡ Estimated performance impact of extra input types: ~${estimatedExtraTime.toFixed(0)}ms`);
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('dmmf-compare')
    .description('🔍 Compare DMMF structures to diagnose performance differences')
    .version('1.0.0')
    .option('-s, --schema <path>', 'Path to Prisma schema file', './test-schemas/large-schema.prisma')
    .addHelpText('after', `
Examples:
  ts-node ./src/dmmf-compare.ts --schema ./my-schema.prisma
  npm run dmmf-compare -- --schema ./test-schemas/extra-large-schema.prisma`);

  program.parse();
  const options = program.opts();

  console.log('🔍 DMMF Structure Comparison Tool');
  console.log('='.repeat(60));
  console.log(`📋 Schema: ${options.schema}`);

  try {
    await comparePreviewFeatures(options.schema);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export default main;
