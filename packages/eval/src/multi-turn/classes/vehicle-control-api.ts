// VehicleControlAPI - Full port from Python
export interface VehicleScenario {
  random_seed?: number;
  fuelLevel?: number;
  batteryVoltage?: number;
  engineState?: string;
  remainingUnlockedDoors?: number;
  doorStatus?: Record<string, string>;
  acTemperature?: number;
  fanSpeed?: number;
  acMode?: string;
  humidityLevel?: number;
  headLightStatus?: string;
  parkingBrakeStatus?: string;
  parkingBrakeForce?: number;
  slopeAngle?: number;
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

const MAX_FUEL_LEVEL = 50;
const MIN_FUEL_LEVEL = 0.0;
const MILE_PER_GALLON = 20.0;

const DEFAULT_STATE: VehicleScenario = {
  random_seed: 141_053,
  fuelLevel: 0.0,
  batteryVoltage: 12.6,
  engineState: "stopped",
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
  parkingBrakeForce: 0.0,
  slopeAngle: 0.0,
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

class SeededRandom {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  uniform(min: number, max: number): number {
    this.seed = (this.seed * 9301 + 49_297) % 233_280;
    const rnd = this.seed / 233_280;
    return min + rnd * (max - min);
  }
}

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
  private _parkingBrakeForce: number;
  private _slopeAngle: number;
  private brakePedalStatus: string;
  private _brakePedalForce: number;
  private distanceToNextVehicle: number;
  private cruiseStatus: string;
  private destination: string;
  private frontLeftTirePressure: number;
  private frontRightTirePressure: number;
  private rearLeftTirePressure: number;
  private rearRightTirePressure: number;
  private longContext = false;
  private _random: SeededRandom;
  private readonly _apiDescription =
    "This tool belongs to the vehicle control system, which allows users to control various aspects of the car such as engine, doors, climate control, lights, and more.";

  constructor() {
    this.fuelLevel = 0.0;
    this.batteryVoltage = 12.6;
    this.engineState = "stopped";
    this.remainingUnlockedDoors = 4;
    this.doorStatus = {
      driver: "unlocked",
      passenger: "unlocked",
      rear_left: "unlocked",
      rear_right: "unlocked",
    };
    this.acTemperature = 25.0;
    this.fanSpeed = 50;
    this.acMode = "auto";
    this.humidityLevel = 50.0;
    this.headLightStatus = "off";
    this.parkingBrakeStatus = "released";
    this._parkingBrakeForce = 0.0;
    this._slopeAngle = 0.0;
    this.brakePedalStatus = "released";
    this._brakePedalForce = 0.0;
    this.distanceToNextVehicle = 50.0;
    this.cruiseStatus = "inactive";
    this.destination = "None";
    this.frontLeftTirePressure = 32.0;
    this.frontRightTirePressure = 32.0;
    this.rearLeftTirePressure = 30.0;
    this.rearRightTirePressure = 30.0;
    this._random = new SeededRandom(141_053);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Scenario loading requires many field initializations
  _loadScenario(scenario: VehicleScenario, longContext = false): void {
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this._random = new SeededRandom(
      scenario.random_seed ?? defaultCopy.random_seed
    );
    this.fuelLevel = scenario.fuelLevel ?? defaultCopy.fuelLevel;
    this.batteryVoltage = scenario.batteryVoltage ?? defaultCopy.batteryVoltage;
    this.engineState = scenario.engineState ?? defaultCopy.engineState;
    this.doorStatus = scenario.doorStatus ?? defaultCopy.doorStatus;
    this.remainingUnlockedDoors =
      4 -
      Object.values(this.doorStatus).filter((status) => status === "locked")
        .length;
    this.acTemperature = scenario.acTemperature ?? defaultCopy.acTemperature;
    this.fanSpeed = scenario.fanSpeed ?? defaultCopy.fanSpeed;
    this.acMode = scenario.acMode ?? defaultCopy.acMode;
    this.humidityLevel = scenario.humidityLevel ?? defaultCopy.humidityLevel;
    this.headLightStatus =
      scenario.headLightStatus ?? defaultCopy.headLightStatus;
    this.parkingBrakeStatus =
      scenario.parkingBrakeStatus ?? defaultCopy.parkingBrakeStatus;
    this._parkingBrakeForce =
      scenario.parkingBrakeForce ?? defaultCopy.parkingBrakeForce;
    this._slopeAngle = scenario.slopeAngle ?? defaultCopy.slopeAngle;
    this.brakePedalStatus =
      scenario.brakePedalStatus ?? defaultCopy.brakePedalStatus;
    this._brakePedalForce =
      scenario.brakePedalForce ?? defaultCopy.brakePedalForce;
    this.distanceToNextVehicle =
      scenario.distanceToNextVehicle ?? defaultCopy.distanceToNextVehicle;
    this.cruiseStatus = scenario.cruiseStatus ?? defaultCopy.cruiseStatus;
    this.destination = scenario.destination ?? defaultCopy.destination;
    this.frontLeftTirePressure =
      scenario.frontLeftTirePressure ?? defaultCopy.frontLeftTirePressure;
    this.frontRightTirePressure =
      scenario.frontRightTirePressure ?? defaultCopy.frontRightTirePressure;
    this.rearLeftTirePressure =
      scenario.rearLeftTirePressure ?? defaultCopy.rearLeftTirePressure;
    this.rearRightTirePressure =
      scenario.rearRightTirePressure ?? defaultCopy.rearRightTirePressure;
    this.longContext = longContext;
  }

  equals(other: unknown): boolean {
    if (!(other instanceof VehicleControlAPI)) {
      return false;
    }
    for (const attrName of Object.keys(this) as (keyof VehicleControlAPI)[]) {
      if (attrName.startsWith("_")) {
        continue;
      }
      const modelAttr = this[attrName];
      const groundTruthAttr = other[attrName];
      if (JSON.stringify(modelAttr) !== JSON.stringify(groundTruthAttr)) {
        return false;
      }
    }
    return true;
  }

  startEngine(ignitionMode: string): Record<string, unknown> {
    if (ignitionMode === "STOP") {
      this.engineState = "stopped";
    }
    if (this.remainingUnlockedDoors > 0) {
      const unlockedDoors = Object.entries(this.doorStatus)
        .filter(([, status]) => status === "unlocked")
        .map(([door]) => door)
        .join(", ");
      return {
        error: `All doors must be locked before starting the engine. Here are the unlocked doors: ${unlockedDoors}`,
      };
    }
    if (this.brakePedalStatus !== "pressed") {
      return {
        error: "Brake pedal needs to be pressed when starting the engine.",
      };
    }
    if (this._brakePedalForce !== 1000.0) {
      return {
        error: "Must press the brake fully before starting the engine.",
      };
    }
    if (this.fuelLevel < MIN_FUEL_LEVEL) {
      return { error: "Fuel tank is empty." };
    }
    if (ignitionMode === "START") {
      this.engineState = "running";
    } else {
      return { error: "Invalid ignition mode." };
    }
    return {
      engineState: this.engineState,
      fuelLevel: this.fuelLevel,
      batteryVoltage: this.batteryVoltage,
    };
  }

  fillFuelTank(fuelAmount: number): Record<string, unknown> {
    if (fuelAmount < 0) {
      return { error: "Fuel amount cannot be negative." };
    }
    if (this.fuelLevel + fuelAmount > MAX_FUEL_LEVEL) {
      return { error: "Cannot fill gas above the tank capacity." };
    }
    if (this.fuelLevel + fuelAmount < MIN_FUEL_LEVEL) {
      return { error: "Fuel tank is empty. Min fuel level is 0 gallons." };
    }
    this.fuelLevel += fuelAmount;
    return { fuelLevel: this.fuelLevel };
  }

  lockDoors(unlock: boolean, door: string[]): Record<string, unknown> {
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

  adjustClimateControl(
    temperature: number,
    unit = "celsius",
    fanSpeed = 50,
    mode = "auto"
  ): Record<string, unknown> {
    if (fanSpeed < 0 || fanSpeed > 100) {
      return { error: "Fan speed must be between 0 and 100." };
    }
    this.acTemperature = temperature;
    if (unit === "fahrenheit") {
      this.acTemperature = ((temperature - 32) * 5) / 9;
    }
    this.fanSpeed = fanSpeed;
    this.acMode = mode;
    return {
      currentACTemperature: temperature,
      climateMode: mode,
      humidityLevel: this.humidityLevel,
    };
  }

  get_outside_temperature_from_google(): Record<string, unknown> {
    return { outsideTemperature: this._random.uniform(-10.0, 40.0) };
  }

  get_outside_temperature_from_weather_com(): Record<string, unknown> {
    return { error: 404 };
  }

  setHeadlights(mode: string): Record<string, string> {
    if (!["on", "off", "auto"].includes(mode)) {
      return { error: "Invalid headlight mode." };
    }
    this.headLightStatus = mode === "on" ? "on" : "off";
    return { headlightStatus: this.headLightStatus };
  }

  displayCarStatus(option: string): Record<string, unknown> {
    const status: Record<string, unknown> = {};
    if (option === "fuel") {
      status.fuelLevel = this.fuelLevel;
    } else if (option === "battery") {
      status.batteryVoltage = this.batteryVoltage;
    } else if (option === "doors") {
      status.doorStatus = this.doorStatus;
    } else if (option === "climate") {
      status.currentACTemperature = this.acTemperature;
      status.fanSpeed = this.fanSpeed;
      status.climateMode = this.acMode;
      status.humidityLevel = this.humidityLevel;
    } else if (option === "headlights") {
      status.headlightStatus = this.headLightStatus;
    } else if (option === "parkingBrake") {
      status.parkingBrakeStatus = this.parkingBrakeStatus;
      status.parkingBrakeForce = this._parkingBrakeForce;
      status.slopeAngle = this._slopeAngle;
    } else if (option === "brakePedal") {
      status.brakePedalStatus = this.brakePedalStatus;
      status.brakePedalForce = this._brakePedalForce;
    } else if (option === "engine") {
      status.engineState = this.engineState;
    } else {
      status.error = "Invalid option";
    }
    return status;
  }

  activateParkingBrake(mode: string): Record<string, unknown> {
    if (!["engage", "release"].includes(mode)) {
      return { error: "Invalid mode" };
    }
    if (mode === "engage") {
      this.parkingBrakeStatus = "engaged";
      this._parkingBrakeForce = 500.0;
      this._slopeAngle = 10.0;
      return {
        parkingBrakeStatus: "engaged",
        _parkingBrakeForce: 500.0,
        _slopeAngle: 10.0,
      };
    }
    this.parkingBrakeStatus = "released";
    this._parkingBrakeForce = 0.0;
    this._slopeAngle = 10.0;
    return {
      parkingBrakeStatus: "released",
      _parkingBrakeForce: 0.0,
      _slopeAngle: 10.0,
    };
  }

  pressBrakePedal(pedalPosition: number): Record<string, unknown> {
    if (pedalPosition < 0 || pedalPosition > 1) {
      return { error: "Pedal position must be between 0 and 1." };
    }
    if (pedalPosition === 0) {
      this.brakePedalStatus = "released";
      this._brakePedalForce = 0.0;
      return { brakePedalStatus: "released", brakePedalForce: 0.0 };
    }
    const maxBrakeForce = 1000;
    const force = pedalPosition * maxBrakeForce;
    this.brakePedalStatus = "pressed";
    this._brakePedalForce = force;
    return { brakePedalStatus: "pressed", brakePedalForce: force };
  }

  releaseBrakePedal(): Record<string, unknown> {
    this.brakePedalStatus = "released";
    this._brakePedalForce = 0.0;
    return { brakePedalStatus: "released", brakePedalForce: 0.0 };
  }

  setCruiseControl(
    speed: number,
    activate: boolean,
    distanceToNextVehicle: number
  ): Record<string, unknown> {
    const dist = Number(distanceToNextVehicle);
    const spd = Number(speed);

    if (this.engineState === "stopped") {
      return {
        error: "Start the engine before activating the cruise control.",
      };
    }
    if (activate) {
      this.distanceToNextVehicle = dist;
      if (spd < 0 || spd > 120 || spd % 5 !== 0) {
        return { error: "Invalid speed" };
      }
      this.cruiseStatus = "active";
      return {
        cruiseStatus: "active",
        currentSpeed: spd,
        distanceToNextVehicle: dist,
      };
    }
    this.cruiseStatus = "inactive";
    this.distanceToNextVehicle = dist;
    return {
      cruiseStatus: "inactive",
      currentSpeed: spd,
      distanceToNextVehicle: dist,
    };
  }

  get_current_speed(): Record<string, number> {
    return { currentSpeed: this._random.uniform(0.0, 120.0) };
  }

  display_log(messages: string[]): Record<string, string[]> {
    return { log: messages };
  }

  estimate_drive_feasibility_by_mileage(
    distance: number
  ): Record<string, boolean> {
    if (this.fuelLevel * MILE_PER_GALLON < distance) {
      return { canDrive: false };
    }
    return { canDrive: true };
  }

  liter_to_gallon(liter: number): Record<string, number> {
    return { gallon: liter * 0.264_172 };
  }

  gallon_to_liter(gallon: number): Record<string, number> {
    return { liter: gallon * 3.785_41 };
  }

  estimate_distance(cityA: string, cityB: string): Record<string, unknown> {
    const distances: Record<string, number> = {
      "83214-74532": 750.0,
      "56108-62947": 320.0,
      "71354-83462": 450.0,
      "47329-52013": 290.0,
      "69238-51479": 630.0,
      "94016-83214": 980.0,
      "94016-94704": 600.0,
      "94704-08540": 2550.0,
      "94016-08540": 1950.0,
      "62947-47329": 1053.0,
      "94016-62947": 780.0,
      "74532-94016": 880.0,
    };

    const key1 = `${cityA}-${cityB}`;
    const key2 = `${cityB}-${cityA}`;

    if (distances[key1] !== undefined) {
      return { distance: distances[key1] };
    }
    if (distances[key2] !== undefined) {
      return { distance: distances[key2] };
    }
    return { error: "distance not found in database." };
  }

  get_zipcode_based_on_city(city: string): Record<string, string> {
    const zipcodes: Record<string, string> = {
      Rivermist: "83214",
      Stonebrook: "74532",
      Maplecrest: "56108",
      Silverpine: "62947",
      Shadowridge: "71354",
      "Sunset Valley": "83462",
      Oakendale: "47329",
      Willowbend: "52013",
      "Crescent Hollow": "69238",
      Autumnville: "51479",
      "San Francisco": "94016",
    };
    return { zipcode: zipcodes[city] ?? "00000" };
  }

  set_navigation(destination: string): Record<string, string> {
    this.destination = destination;
    return { status: `Navigating to ${destination}` };
  }

  check_tire_pressure(): Record<string, unknown> {
    const avgPressure =
      (this.frontLeftTirePressure +
        this.frontRightTirePressure +
        this.rearLeftTirePressure +
        this.rearRightTirePressure) /
      4;
    const healthyTirePressure = avgPressure >= 30 && avgPressure <= 35;

    return {
      frontLeftTirePressure: this.frontLeftTirePressure,
      frontRightTirePressure: this.frontRightTirePressure,
      rearLeftTirePressure: this.rearLeftTirePressure,
      rearRightTirePressure: this.rearRightTirePressure,
      healthy_tire_pressure: healthyTirePressure,
      car_info: {},
    };
  }

  find_nearest_tire_shop(): Record<string, string> {
    return { shopLocation: "456 Oakwood Avenue, Rivermist, 83214" };
  }
}
