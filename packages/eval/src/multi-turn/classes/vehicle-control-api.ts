// VehicleControlAPI - Simplified port
export interface VehicleScenario {
  random_seed?: number;
  fuelLevel?: number;
  batteryVoltage?: number;
  engine_state?: string;
  remainingUnlockedDoors?: number;
  doorStatus?: Record<string, string>;
  acTemperature?: number;
  fanSpeed?: number;
  acMode?: string;
  humidityLevel?: number;
  headLightStatus?: string;
  parkingBrakeStatus?: string;
  brakePedalStatus?: string;
  brakePedalForce?: number;
  distanceToNextVehicle?: number;
  cruiseStatus?: string;
  destination?: string;
  frontLeftTirePressure?: number;
  frontRightTirePressure?: number;
  rearLeftTirePressure?: number;
  rearRightTirePressure?: number;
}

const DEFAULT_STATE: VehicleScenario = {
  random_seed: 141_053,
  fuelLevel: 0.0,
  batteryVoltage: 12.6,
  engine_state: "stopped",
  remainingUnlockedDoors: 4,
  doorStatus: {
    driver: "unlocked",
    passenger: "unlocked",
    rear_left: "unlocked",
    rear_right: "unlocked",
  },
  acTemperature: 25.0,
  fanSpeed: 50,
  acMode: "auto",
  humidityLevel: 50.0,
  headLightStatus: "off",
  parkingBrakeStatus: "released",
  brakePedalStatus: "released",
  brakePedalForce: 0.0,
  distanceToNextVehicle: 50.0,
  cruiseStatus: "inactive",
  destination: "None",
  frontLeftTirePressure: 32.0,
  frontRightTirePressure: 32.0,
  rearLeftTirePressure: 30.0,
  rearRightTirePressure: 30.0,
};

export class VehicleControlAPI {
  private fuelLevel: number;
  private batteryVoltage: number;
  private engineState: string;
  private remainingUnlockedDoors: number;
  private doorStatus: Record<string, string>;
  private acTemperature: number;
  private fanSpeed: number;
  private acMode: string;
  private humidityLevel: number;
  private headLightStatus: string;
  private parkingBrakeStatus: string;
  private brakePedalStatus: string;
  private brakePedalForce: number;
  private distanceToNextVehicle: number;
  private cruiseStatus: string;
  private destination: string;
  private frontLeftTirePressure: number;
  private frontRightTirePressure: number;
  private rearLeftTirePressure: number;
  private rearRightTirePressure: number;
  private longContext = false;
  private _apiDescription =
    "This tool belongs to the vehicle control system, which allows users to control various aspects of the car such as engine, doors, climate control, lights, and more.";

  constructor() {
    this.fuelLevel = 0.0;
    this.batteryVoltage = 12.6;
    this.engineState = "stopped";
    this.remainingUnlockedDoors = 4;
    this.doorStatus = {};
    this.acTemperature = 25.0;
    this.fanSpeed = 50;
    this.acMode = "auto";
    this.humidityLevel = 50.0;
    this.headLightStatus = "off";
    this.parkingBrakeStatus = "released";
    this.brakePedalStatus = "released";
    this.brakePedalForce = 0.0;
    this.distanceToNextVehicle = 50.0;
    this.cruiseStatus = "inactive";
    this.destination = "None";
    this.frontLeftTirePressure = 32.0;
    this.frontRightTirePressure = 32.0;
    this.rearLeftTirePressure = 30.0;
    this.rearRightTirePressure = 30.0;
  }

  _loadScenario(scenario: VehicleScenario, longContext = false): void {
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_STATE));
    // Simplified loading
    Object.assign(this, { ...defaultCopy, ...scenario });
    this.longContext = longContext;
  }

  equals(other: any): boolean {
    if (!(other instanceof VehicleControlAPI)) return false;
    // Compare key attributes
    return (
      this.fuelLevel === other.fuelLevel &&
      this.engineState === other.engineState &&
      JSON.stringify(this.doorStatus) === JSON.stringify(other.doorStatus)
    );
  }

  startEngine(ignitionMode: string): Record<string, any> {
    if (this.remainingUnlockedDoors > 0) {
      return {
        error:
          "All doors must be locked before starting the engine. Here are the unlocked doors: " +
          Object.keys(this.doorStatus)
            .filter((door) => this.doorStatus[door] === "unlocked")
            .join(", "),
      };
    }
    if (this.brakePedalStatus !== "pressed") {
      return {
        error: "Brake pedal needs to be pressed when starting the engine.",
      };
    }
    if (this.fuelLevel < 0) {
      return { error: "Fuel tank is empty." };
    }

    if (ignitionMode === "START") {
      this.engineState = "running";
    }
    return {
      engineState: this.engineState,
      fuelLevel: this.fuelLevel,
      batteryVoltage: this.batteryVoltage,
    };
  }

  lockDoors(unlock: boolean, door: string[]): Record<string, any> {
    if (unlock) {
      for (const d of door) {
        if (this.doorStatus[d] === "unlocked") {
          continue;
        }
        this.doorStatus[d] = "unlocked";
        this.remainingUnlockedDoors += 1;
      }
      return {
        lockStatus: "unlocked",
        remainingUnlockedDoors: this.remainingUnlockedDoors,
      };
    }
    for (const d of door) {
      if (this.doorStatus[d] === "locked") {
        continue;
      }
      this.doorStatus[d] = "locked";
      this.remainingUnlockedDoors -= 1;
    }
    return {
      lockStatus: "locked",
      remainingUnlockedDoors: this.remainingUnlockedDoors,
    };
  }

  setHeadlights(mode: string): Record<string, string> {
    if (!["on", "off", "auto"].includes(mode)) {
      return { error: "Invalid headlight mode." };
    }
    this.headLightStatus = mode === "on" ? "on" : "off";
    return { headlightStatus: this.headLightStatus };
  }

  pressBrakePedal(pedalPosition: number): Record<string, any> {
    if (pedalPosition < 0 || pedalPosition > 1) {
      return { error: "Pedal position must be between 0 and 1." };
    }

    if (pedalPosition === 0) {
      this.brakePedalStatus = "released";
      this.brakePedalForce = 0.0;
      return { brakePedalStatus: "released", brakePedalForce: 0.0 };
    }

    const maxBrakeForce = 1000;
    const force = pedalPosition * maxBrakeForce;
    this.brakePedalStatus = "pressed";
    this.brakePedalForce = force;
    return { brakePedalStatus: "pressed", brakePedalForce: force };
  }

  // Additional methods would be implemented...
}
