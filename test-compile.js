#!/usr/bin/env node
const { execSync } = require('child_process');

try {
  console.log('Running TypeScript compilation check...');
  execSync('cd packages/parser && npx tsc --noEmit', { 
    stdio: 'inherit',
    timeout: 60000 
  });
  console.log('✓ TypeScript compilation successful!');
  process.exit(0);
} catch (error) {
  console.error('✗ TypeScript compilation failed');
  process.exit(1);
}
