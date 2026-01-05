// Method registry for safe method invocation
// Replaces Python's dynamic import and eval system

import { CLASS_NAME_TO_CLASS, STATELESS_CLASSES } from "./constants";

// biome-ignore lint/suspicious/noExplicitAny: Dynamic instance storage for various class types
export type InstanceRegistry = Record<string, any>;

export class MethodRegistry {
  private instances: InstanceRegistry = {};
  private methodMapping: Record<string, string> = {}; // method_name -> instance_key

  constructor() {
    // Initialize stateless classes (MathAPI)
    for (const className of STATELESS_CLASSES) {
      const ClassConstructor = CLASS_NAME_TO_CLASS[className];
      if (ClassConstructor) {
        const instance = new ClassConstructor();
        const instanceKey = `${className}_stateless_instance`;
        this.instances[instanceKey] = instance;

        // Register all methods
        const methods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(instance)
        ).filter(
          (name) =>
            typeof instance[name] === "function" && name !== "constructor"
        );

        for (const methodName of methods) {
          this.methodMapping[methodName] = instanceKey;
        }
      }
    }
  }

  getOrCreateInstance(
    className: string,
    testEntryId: string,
    modelName: string,
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic scenario data from JSON
    scenario: any,
    longContext = false,
    isEvalRun = false
    // biome-ignore lint/suspicious/noExplicitAny: Returns dynamically typed class instance
  ): any {
    const instanceKey = `${modelName}_${testEntryId}_${className}_${isEvalRun ? "eval" : "model"}_instance`;

    if (!this.instances[instanceKey]) {
      const ClassConstructor = CLASS_NAME_TO_CLASS[className];
      if (!ClassConstructor) {
        throw new Error(`Unknown class: ${className}`);
      }

      const instance = new ClassConstructor();
      // Only call _loadScenario for stateful classes
      if (
        !STATELESS_CLASSES.has(className) &&
        typeof instance._loadScenario === "function"
      ) {
        instance._loadScenario(scenario, longContext);
      }
      this.instances[instanceKey] = instance;

      // Register methods for this instance
      const methods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(instance)
      ).filter(
        (name) =>
          typeof instance[name] === "function" &&
          name !== "constructor" &&
          !name.startsWith("_")
      );

      for (const methodName of methods) {
        this.methodMapping[methodName] = instanceKey;
      }
    }

    return this.instances[instanceKey];
  }

  // biome-ignore lint/suspicious/noExplicitAny: Returns dynamically typed class instance
  getInstanceByMethod(methodName: string): any {
    const instanceKey = this.methodMapping[methodName];
    if (!instanceKey) {
      throw new Error(`Method not found: ${methodName}`);
    }
    return this.instances[instanceKey];
  }

  // Get all instances for a specific test case
  getInstancesForTest(
    testEntryId: string,
    modelName: string
  ): InstanceRegistry {
    const result: InstanceRegistry = {};
    for (const [key, instance] of Object.entries(this.instances)) {
      if (key.includes(`${modelName}_${testEntryId}`)) {
        result[key] = instance;
      }
    }
    return result;
  }

  // Clear instances for a specific test case
  clearInstancesForTest(testEntryId: string, modelName: string): void {
    const keysToDelete: string[] = [];
    for (const key of Object.keys(this.instances)) {
      if (key.includes(`${modelName}_${testEntryId}`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      delete this.instances[key];
    }

    // Remove method mappings for deleted instances
    const methodsToDelete: string[] = [];
    for (const [method, instanceKey] of Object.entries(this.methodMapping)) {
      if (keysToDelete.includes(instanceKey)) {
        methodsToDelete.push(method);
      }
    }
    for (const method of methodsToDelete) {
      delete this.methodMapping[method];
    }
  }

  // Reset all instances (for testing)
  reset(): void {
    this.instances = {};
    this.methodMapping = {};

    // Re-initialize stateless classes
    for (const className of STATELESS_CLASSES) {
      const ClassConstructor = CLASS_NAME_TO_CLASS[className];
      if (ClassConstructor) {
        const instance = new ClassConstructor();
        const instanceKey = `${className}_stateless_instance`;
        this.instances[instanceKey] = instance;

        const methods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(instance)
        ).filter(
          (name) =>
            typeof instance[name] === "function" && name !== "constructor"
        );

        for (const methodName of methods) {
          this.methodMapping[methodName] = instanceKey;
        }
      }
    }
  }
}

// Global registry instance
export const globalMethodRegistry = new MethodRegistry();
