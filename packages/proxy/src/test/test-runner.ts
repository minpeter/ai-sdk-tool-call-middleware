#!/usr/bin/env node

/**
 * Comprehensive Test Runner for OpenAI Proxy Server
 * Runs all test suites and generates detailed reports
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type TestResult = {
  name: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  error?: string;
};

type TestSuite = {
  name: string;
  results: TestResult[];
  totalDuration: number;
  passed: number;
  failed: number;
  skipped: number;
};

class TestRunner {
  private readonly suites: TestSuite[] = [];
  private startTime = 0;

  async runAllTests(): Promise<void> {
    console.log("🚀 Starting OpenAI Proxy Server Test Suite");
    console.log("=".repeat(50));

    this.startTime = Date.now();

    const testSuites = [
      {
        name: "Basic Functionality",
        file: "basic-functionality.test.ts",
        description: "Core API functionality tests",
      },
      {
        name: "Tool Calling",
        file: "tool-calling.test.ts",
        description: "Tool calling and execution tests",
      },
      {
        name: "Performance",
        file: "performance.test.ts",
        description: "Performance and load tests",
      },
      {
        name: "Error Handling",
        file: "error-handling.test.ts",
        description: "Error handling and edge cases",
      },
    ];

    for (const suite of testSuites) {
      await this.runTestSuite(suite);
    }

    await this.generateReport();
  }

  private async runTestSuite(suite: {
    name: string;
    file: string;
    description: string;
  }): Promise<void> {
    console.log(`\n📋 Running ${suite.name} Tests`);
    console.log(`   ${suite.description}`);
    console.log("-".repeat(40));

    const suiteStartTime = Date.now();

    try {
      const result = await this.runVitest(suite.file);
      const suiteEndTime = Date.now();

      const testSuite: TestSuite = {
        name: suite.name,
        results: this.parseVitestOutput(result.stdout),
        totalDuration: suiteEndTime - suiteStartTime,
        passed: 0,
        failed: 0,
        skipped: 0,
      };

      // Count results
      for (const testResult of testSuite.results) {
        if (testResult.status === "passed") {
          testSuite.passed += 1;
        } else if (testResult.status === "failed") {
          testSuite.failed += 1;
        } else {
          testSuite.skipped += 1;
        }
      }

      this.suites.push(testSuite);

      console.log(`✅ ${suite.name} completed in ${testSuite.totalDuration}ms`);
      console.log(
        `   Passed: ${testSuite.passed}, Failed: ${testSuite.failed}, Skipped: ${testSuite.skipped}`
      );
    } catch (error) {
      console.error(`❌ ${suite.name} failed:`, error);

      const failedSuite: TestSuite = {
        name: suite.name,
        results: [],
        totalDuration: Date.now() - suiteStartTime,
        passed: 0,
        failed: 1,
        skipped: 0,
      };

      this.suites.push(failedSuite);
    }
  }

  // biome-ignore lint/suspicious/useAwait: function spawns child process
  private async runVitest(
    testFile: string
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const vitest = spawn("pnpm", ["test", testFile, "--reporter=verbose"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      vitest.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      vitest.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      vitest.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Vitest exited with code ${code}\n${stderr}`));
        }
      });

      vitest.on("error", (error) => {
        reject(error);
      });
    });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: vitest output parsing requires complex logic
  private parseVitestOutput(output: string): TestResult[] {
    const results: TestResult[] = [];
    const lines = output.split("\n");

    let currentTest = "";
    let testStartTime = 0;

    for (const line of lines) {
      // Parse test start
      if (line.includes("›") && line.includes("should")) {
        currentTest = line.trim();
        testStartTime = Date.now();
      }

      // Parse test result
      if (line.includes("✓") || line.includes("❌") || line.includes("⎯")) {
        // biome-ignore lint/style/noNestedTernary: simple status mapping
        let status: "passed" | "failed" | "skipped";
        if (line.includes("✓")) {
          status = "passed";
        } else if (line.includes("❌")) {
          status = "failed";
        } else {
          status = "skipped";
        }

        if (currentTest) {
          results.push({
            name: currentTest,
            status,
            duration: Date.now() - testStartTime,
          });
          currentTest = "";
        }
      }
    }

    return results;
  }

  private async generateReport(): Promise<void> {
    const totalTime = Date.now() - this.startTime;
    const totalPassed = this.suites.reduce((sum, s) => sum + s.passed, 0);
    const totalFailed = this.suites.reduce((sum, s) => sum + s.failed, 0);
    const totalSkipped = this.suites.reduce((sum, s) => sum + s.skipped, 0);
    const totalTests = totalPassed + totalFailed + totalSkipped;

    console.log("\n📊 Test Summary");
    console.log("=".repeat(50));
    console.log(`Total Tests: ${totalTests}`);
    console.log(`Passed: ${totalPassed} ✅`);
    console.log(`Failed: ${totalFailed} ❌`);
    console.log(`Skipped: ${totalSkipped} ⎯`);
    console.log(
      `Success Rate: ${((totalPassed / totalTests) * 100).toFixed(1)}%`
    );
    console.log(`Total Duration: ${totalTime}ms`);

    // Generate detailed report
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalTests,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        successRate: ((totalPassed / totalTests) * 100).toFixed(1),
        totalDuration: totalTime,
      },
      suites: this.suites,
    };

    const reportPath = join(process.cwd(), "test-report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);

    // Generate HTML report
    await this.generateHTMLReport(report);

    // Exit with appropriate code
    if (totalFailed > 0) {
      console.log("\n❌ Some tests failed");
      process.exit(1);
    } else {
      console.log("\n✅ All tests passed!");
      process.exit(0);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: report object from dynamic test results
  private async generateHTMLReport(report: any): Promise<void> {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenAI Proxy Server Test Report</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .metric { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
        .metric-value { font-size: 2em; font-weight: bold; color: #333; }
        .metric-label { color: #666; margin-top: 5px; }
        .suite { background: white; margin-bottom: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .suite-header { padding: 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
        .suite-name { font-weight: bold; font-size: 1.2em; }
        .suite-stats { display: flex; gap: 15px; }
        .stat { padding: 4px 8px; border-radius: 4px; font-size: 0.9em; }
        .passed { background: #d4edda; color: #155724; }
        .failed { background: #f8d7da; color: #721c24; }
        .skipped { background: #fff3cd; color: #856404; }
        .test-results { padding: 20px; }
        .test-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
        .test-name { font-family: monospace; }
        .test-status { padding: 2px 8px; border-radius: 4px; font-size: 0.8em; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚀 OpenAI Proxy Server Test Report</h1>
        <p>Generated on ${new Date(report.timestamp).toLocaleString()}</p>
    </div>

    <div class="summary">
        <div class="metric">
            <div class="metric-value">${report.summary.totalTests}</div>
            <div class="metric-label">Total Tests</div>
        </div>
        <div class="metric">
            <div class="metric-value" style="color: #28a745;">${report.summary.passed}</div>
            <div class="metric-label">Passed</div>
        </div>
        <div class="metric">
            <div class="metric-value" style="color: #dc3545;">${report.summary.failed}</div>
            <div class="metric-label">Failed</div>
        </div>
        <div class="metric">
            <div class="metric-value">${report.summary.successRate}%</div>
            <div class="metric-label">Success Rate</div>
        </div>
        <div class="metric">
            <div class="metric-value">${(report.summary.totalDuration / 1000).toFixed(1)}s</div>
            <div class="metric-label">Total Duration</div>
        </div>
    </div>

    ${report.suites
      .map(
        // biome-ignore lint/suspicious/noExplicitAny: dynamic suite object
        (suite: any) => `
        <div class="suite">
            <div class="suite-header">
                <div class="suite-name">${suite.name}</div>
                <div class="suite-stats">
                    <span class="stat passed">${suite.passed} passed</span>
                    <span class="stat failed">${suite.failed} failed</span>
                    <span class="stat skipped">${suite.skipped} skipped</span>
                    <span class="stat">${(suite.totalDuration / 1000).toFixed(1)}s</span>
                </div>
            </div>
            <div class="test-results">
                ${suite.results
                  .map(
                    // biome-ignore lint/suspicious/noExplicitAny: dynamic test object
                    (test: any) => `
                    <div class="test-item">
                        <div class="test-name">${test.name}</div>
                        <div class="test-status ${test.status}">${test.status}</div>
                    </div>
                `
                  )
                  .join("")}
            </div>
        </div>
    `
      )
      .join("")}
</body>
</html>`;

    const htmlPath = join(process.cwd(), "test-report.html");
    await writeFile(htmlPath, html);
    console.log(`📄 HTML report saved to: ${htmlPath}`);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const runner = new TestRunner();
  runner.runAllTests().catch(console.error);
}

export { TestRunner };
