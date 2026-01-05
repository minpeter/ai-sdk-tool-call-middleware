import { Decimal } from "decimal.js";

export class MathAPI {
  logarithm(
    value: number,
    base: number,
    precision: number
  ): Record<string, any> {
    try {
      // Set precision for Decimal.js
      Decimal.set({ precision });

      // Use Decimal for high-precision logarithmic calculations
      const result = new Decimal(value).ln().div(new Decimal(base).ln());

      return { result: result.toNumber() };
    } catch (e) {
      return { error: String(e) };
    }
  }

  mean(numbers: number[]): Record<string, any> {
    if (!numbers.length) {
      return { error: "Cannot calculate mean of an empty list" };
    }
    try {
      return { result: numbers.reduce((a, b) => a + b, 0) / numbers.length };
    } catch (_e) {
      return { error: "All elements in the list must be numbers" };
    }
  }

  standardDeviation(numbers: number[]): Record<string, any> {
    if (!numbers.length) {
      return { error: "Cannot calculate standard deviation of an empty list" };
    }
    try {
      const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      const variance =
        numbers.reduce((sum, x) => sum + (x - mean) ** 2, 0) / numbers.length;
      return { result: Math.sqrt(variance) };
    } catch (_e) {
      return { error: "All elements in the list must be numbers" };
    }
  }

  siUnitConversion(
    value: number,
    unitIn: string,
    unitOut: string
  ): Record<string, any> {
    const toMeters: Record<string, any> = {
      km: 1000,
      m: 1,
      cm: 0.01,
      mm: 0.001,
      um: 1e-6,
      nm: 1e-9,
    };
    const fromMeters = Object.fromEntries(
      Object.entries(toMeters).map(([k, v]) => [k, 1 / v])
    );

    if (typeof value !== "number") {
      return { error: "Value must be a number" };
    }

    if (!(unitIn in toMeters && unitOut in fromMeters)) {
      return {
        error: `Conversion from '${unitIn}' to '${unitOut}' is not supported`,
      };
    }

    try {
      const valueInMeters = value * toMeters[unitIn];
      const result = valueInMeters * fromMeters[unitOut];
      return { result };
    } catch (_e) {
      return { error: "Conversion resulted in a value too large to represent" };
    }
  }

  imperialSiConversion(
    value: number,
    unitIn: string,
    unitOut: string
  ): Record<string, any> {
    const conversion: Record<string, any> = {
      cm_to_in: 0.393_701,
      in_to_cm: 2.54,
      m_to_ft: 3.280_84,
      ft_to_m: 0.3048,
      m_to_yd: 1.093_61,
      yd_to_m: 0.9144,
      km_to_miles: 0.621_371,
      miles_to_km: 1.609_34,
      kg_to_lb: 2.204_62,
      lb_to_kg: 0.453_592,
      celsius_to_fahrenheit: 1.8,
      fahrenheit_to_celsius: 5 / 9,
    };

    if (typeof value !== "number") {
      return { error: "Value must be a number" };
    }

    if (unitIn === unitOut) {
      return { result: value };
    }

    const conversionKey = `${unitIn}_to_${unitOut}`;
    if (!(conversionKey in conversion)) {
      return {
        error: `Conversion from '${unitIn}' to '${unitOut}' is not supported`,
      };
    }

    try {
      let result: number;
      if (unitIn === "celsius" && unitOut === "fahrenheit") {
        result = value * conversion[conversionKey] + 32;
      } else if (unitIn === "fahrenheit" && unitOut === "celsius") {
        result = (value - 32) * conversion[conversionKey];
      } else {
        result = value * conversion[conversionKey];
      }

      return { result };
    } catch (_e) {
      return { error: "Conversion resulted in a value too large to represent" };
    }
  }

  add(a: number, b: number): Record<string, any> {
    try {
      return { result: a + b };
    } catch (_e) {
      return { error: "Both inputs must be numbers" };
    }
  }

  subtract(a: number, b: number): Record<string, any> {
    try {
      return { result: a - b };
    } catch (_e) {
      return { error: "Both inputs must be numbers" };
    }
  }

  multiply(a: number, b: number): Record<string, any> {
    if (typeof a !== "number" || typeof b !== "number") {
      return { error: "Both inputs must be numbers" };
    }

    try {
      return { result: a * b };
    } catch (_e) {
      return { error: "Both inputs must be numbers" };
    }
  }

  divide(a: number, b: number): Record<string, any> {
    try {
      if (b === 0) {
        return { error: "Cannot divide by zero" };
      }
      return { result: a / b };
    } catch (_e) {
      return { error: "Both inputs must be numbers" };
    }
  }

  power(base: number, exponent: number): Record<string, any> {
    try {
      return { result: base ** exponent };
    } catch (_e) {
      return { error: "Both inputs must be numbers" };
    }
  }

  squareRoot(number: number, precision: number): Record<string, any> {
    try {
      if (number < 0) {
        return { error: "Cannot calculate square root of a negative number" };
      }

      // Set the precision for Decimal
      Decimal.set({ precision });

      // Use Decimal for high-precision square root calculation
      const decimalNumber = new Decimal(number);
      const result = decimalNumber.sqrt();

      return { result: result.toNumber() };
    } catch (_e) {
      return {
        error:
          "Input must be a number or computation resulted in an invalid operation",
      };
    }
  }

  absoluteValue(number: number): Record<string, any> {
    try {
      return { result: Math.abs(number) };
    } catch (_e) {
      return { error: "Input must be a number" };
    }
  }

  roundNumber(number: number, decimalPlaces = 0): Record<string, any> {
    try {
      return {
        result: Math.round(number * 10 ** decimalPlaces) / 10 ** decimalPlaces,
      };
    } catch (_e) {
      return {
        error: "First input must be a number, second input must be an integer",
      };
    }
  }

  percentage(part: number, whole: number): Record<string, any> {
    try {
      if (whole === 0) {
        return { error: "Whole value cannot be zero" };
      }
      return { result: (part / whole) * 100 };
    } catch (_e) {
      return { error: "Both inputs must be numbers" };
    }
  }

  minValue(numbers: number[]): Record<string, any> {
    if (!numbers.length) {
      return { error: "Cannot find minimum of an empty list" };
    }
    try {
      return { result: Math.min(...numbers) };
    } catch (_e) {
      return { error: "All elements in the list must be numbers" };
    }
  }

  maxValue(numbers: number[]): Record<string, any> {
    if (!numbers.length) {
      return { error: "Cannot find maximum of an empty list" };
    }
    try {
      return { result: Math.max(...numbers) };
    } catch (_e) {
      return { error: "All elements in the list must be numbers" };
    }
  }

  sumValues(numbers: number[]): Record<string, any> {
    if (!numbers.length) {
      return { error: "Cannot calculate sum of an empty list" };
    }
    try {
      return { result: numbers.reduce((a, b) => a + b, 0) };
    } catch (_e) {
      return { error: "All elements in the list must be numbers" };
    }
  }
}
