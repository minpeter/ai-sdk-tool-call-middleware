export interface TravelScenario {
  random_seed?: number;
  credit_card_list?: Record<string, CreditCard>;
  booking_record?: Record<string, BookingRecord>;
  access_token?: string;
  token_type?: string;
  token_expires_in?: number;
  token_scope?: string;
  user_first_name?: string;
  user_last_name?: string;
  budget_limit?: number;
}

interface CreditCard {
  card_number: string;
  expiration_date: string;
  cardholder_name: string;
  card_verification_number: number;
  balance: number;
}

interface BookingRecord {
  card_id: string;
  travel_date: string;
  travel_from: string;
  travel_to: string;
  travel_class: string;
  travel_cost: number;
  transaction_id: string;
}

interface FlightCostEntry {
  cost: number;
}

const DEFAULT_STATE: TravelScenario = {
  random_seed: 141_053,
  credit_card_list: {},
  booking_record: {},
  access_token: undefined,
  token_type: undefined,
  token_expires_in: undefined,
  token_scope: undefined,
  user_first_name: undefined,
  user_last_name: undefined,
  budget_limit: undefined,
};

const BASE_COSTS: Map<string, number> = new Map([
  ["SFO|LAX", 200],
  ["SFO|JFK", 500],
  ["SFO|ORD", 400],
  ["SFO|BOS", 450],
  ["SFO|RMS", 300],
  ["SFO|SBK", 350],
  ["SFO|MPC", 370],
  ["SFO|SVP", 320],
  ["SFO|SHD", 330],
  ["SFO|SSV", 340],
  ["SFO|OKD", 360],
  ["SFO|WLB", 310],
  ["SFO|CRH", 380],
  ["SFO|ATV", 390],
  ["SFO|PHV", 420],
  ["SFO|GFD", 430],
  ["SFO|CIA", 700],
  ["LAX|SFO", 100],
  ["LAX|JFK", 600],
  ["LAX|ORD", 500],
  ["LAX|BOS", 550],
  ["LAX|RMS", 310],
  ["LAX|SBK", 320],
  ["LAX|MPC", 330],
  ["LAX|SVP", 340],
  ["LAX|SHD", 350],
  ["LAX|SSV", 360],
  ["LAX|OKD", 370],
  ["LAX|WLB", 380],
  ["LAX|CRH", 390],
  ["LAX|ATV", 400],
  ["LAX|PHV", 410],
  ["LAX|GFD", 420],
  ["LAX|HND", 430],
  ["JFK|ORD", 300],
  ["JFK|BOS", 250],
  ["JFK|RMS", 450],
  ["JFK|SBK", 460],
  ["JFK|MPC", 470],
  ["JFK|SVP", 480],
  ["JFK|SHD", 490],
  ["JFK|SSV", 500],
  ["JFK|OKD", 510],
  ["JFK|WLB", 520],
  ["JFK|CRH", 530],
  ["JFK|ATV", 540],
  ["JFK|PHV", 550],
  ["JFK|GFD", 560],
  ["JFK|LAX", 570],
  ["JFK|HND", 800],
  ["JFK|PVG", 950],
  ["JFK|PEK", 1000],
  ["ORD|LAX", 180],
  ["ORD|BOS", 200],
  ["ORD|RMS", 350],
  ["ORD|SBK", 360],
  ["ORD|MPC", 370],
  ["ORD|SVP", 380],
  ["ORD|SHD", 390],
  ["ORD|SSV", 400],
  ["ORD|OKD", 410],
  ["ORD|WLB", 420],
  ["ORD|CRH", 430],
  ["ORD|ATV", 440],
  ["ORD|PHV", 450],
  ["ORD|GFD", 460],
  ["BOS|RMS", 400],
  ["BOS|SBK", 410],
  ["BOS|MPC", 420],
  ["BOS|SVP", 430],
  ["BOS|SHD", 440],
  ["BOS|SSV", 450],
  ["BOS|OKD", 460],
  ["BOS|WLB", 470],
  ["BOS|CRH", 480],
  ["BOS|ATV", 490],
  ["BOS|PHV", 500],
  ["BOS|GFD", 510],
  ["RMS|BOS", 200],
  ["RMS|JFK", 210],
  ["RMS|SBK", 220],
  ["RMS|MPC", 230],
  ["RMS|SVP", 240],
  ["RMS|SHD", 250],
  ["RMS|SSV", 260],
  ["RMS|OKD", 270],
  ["RMS|WLB", 280],
  ["RMS|CRH", 290],
  ["RMS|ATV", 300],
  ["RMS|PHV", 310],
  ["RMS|GFD", 320],
  ["RMS|LAX", 330],
  ["SBK|MPC", 200],
  ["SBK|SVP", 210],
  ["SBK|SHD", 220],
  ["SBK|SSV", 230],
  ["SBK|OKD", 240],
  ["SBK|WLB", 250],
  ["SBK|CRH", 260],
  ["SBK|ATV", 270],
  ["SBK|PHV", 280],
  ["SBK|GFD", 290],
  ["MPC|SVP", 210],
  ["MPC|SHD", 220],
  ["MPC|SSV", 230],
  ["MPC|OKD", 240],
  ["MPC|WLB", 250],
  ["MPC|CRH", 260],
  ["MPC|ATV", 270],
  ["MPC|PHV", 280],
  ["MPC|GFD", 290],
  ["SVP|SHD", 230],
  ["SVP|SSV", 240],
  ["SVP|OKD", 250],
  ["SVP|WLB", 260],
  ["SVP|CRH", 270],
  ["SVP|ATV", 280],
  ["SVP|PHV", 290],
  ["SVP|GFD", 300],
  ["SHD|SSV", 220],
  ["SHD|OKD", 230],
  ["SHD|WLB", 240],
  ["SHD|CRH", 250],
  ["SHD|ATV", 260],
  ["SHD|PHV", 270],
  ["SHD|GFD", 280],
  ["SSV|OKD", 240],
  ["SSV|WLB", 250],
  ["SSV|CRH", 260],
  ["SSV|ATV", 270],
  ["SSV|PHV", 280],
  ["SSV|GFD", 290],
  ["OKD|WLB", 230],
  ["OKD|CRH", 240],
  ["OKD|ATV", 250],
  ["OKD|PHV", 260],
  ["OKD|GFD", 270],
  ["WLB|CRH", 250],
  ["WLB|ATV", 260],
  ["WLB|PHV", 270],
  ["WLB|GFD", 280],
  ["CRH|ATV", 240],
  ["CRH|PHV", 250],
  ["CRH|GFD", 260],
  ["CRH|SFO", 270],
  ["CRH|RMS", 280],
  ["CRH|HKG", 290],
  ["CRH|JFK", 300],
  ["ATV|PHV", 230],
  ["ATV|GFD", 240],
  ["PHV|GFD", 220],
  ["LHR|CDG", 100],
  ["OKD|LAX", 220],
]);

const AIRPORT_MAP: Record<string, string> = {
  Rivermist: "RMS",
  Stonebrook: "SBK",
  Maplecrest: "MPC",
  Silverpine: "SVP",
  Shadowridge: "SHD",
  London: "LHR",
  Paris: "CDG",
  "Sunset Valley": "SSV",
  Oakendale: "OKD",
  Willowbend: "WLB",
  "Crescent Hollow": "CRH",
  Autumnville: "ATV",
  Pinehaven: "PHV",
  Greenfield: "GFD",
  "San Francisco": "SFO",
  "Los Angeles": "LAX",
  "New York": "JFK",
  Chicago: "ORD",
  Boston: "BOS",
  Beijing: "PEK",
  "Hong Kong": "HKG",
  Rome: "CIA",
  Tokyo: "HND",
};

const EXCHANGE_RATES: Map<string, number> = new Map([
  ["USD|RMB", 7],
  ["USD|EUR", 0.8],
  ["USD|JPY", 110],
  ["USD|GBP", 0.7],
  ["USD|CAD", 1.3],
  ["USD|AUD", 1.4],
  ["USD|INR", 70],
  ["USD|RUB", 60],
  ["USD|BRL", 3.8],
  ["USD|MXN", 20],
]);

const ALL_AIRPORTS = [
  "RMS",
  "SBK",
  "MPC",
  "SVP",
  "SHD",
  "CDG",
  "LHR",
  "SSV",
  "OKD",
  "WLB",
  "PEK",
  "HND",
  "HKG",
  "CIA",
  "CRH",
  "ATV",
  "PHV",
  "GFD",
  "SFO",
  "LAX",
  "JFK",
  "ORD",
  "BOS",
];

class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return this.seed;
  }

  randInt(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }
}

export class TravelAPI {
  creditCardList: Record<string, CreditCard>;
  bookingRecord: Record<string, BookingRecord>;
  accessToken?: string;
  tokenType?: string;
  tokenExpiresIn?: number;
  tokenScope?: string;
  userFirstName?: string;
  userLastName?: string;
  budgetLimit?: number;
  longContext = false;
  private _random: SeededRandom;
  private readonly _flightCostLookup: Map<string, FlightCostEntry> = new Map();

  constructor() {
    this.creditCardList = {};
    this.bookingRecord = {};
    this._random = new SeededRandom(DEFAULT_STATE.random_seed ?? 141_053);
  }

  _loadScenario(scenario: TravelScenario, longContext = false): void {
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this._random = new SeededRandom(
      scenario.random_seed ?? defaultCopy.random_seed
    );

    this.creditCardList =
      scenario.credit_card_list ?? defaultCopy.credit_card_list;
    this.bookingRecord = scenario.booking_record ?? defaultCopy.booking_record;
    this.accessToken = scenario.access_token ?? defaultCopy.access_token;
    this.tokenType = scenario.token_type ?? defaultCopy.token_type;
    this.tokenExpiresIn =
      scenario.token_expires_in ?? defaultCopy.token_expires_in;
    this.tokenScope = scenario.token_scope ?? defaultCopy.token_scope;
    this.userFirstName =
      scenario.user_first_name ?? defaultCopy.user_first_name;
    this.userLastName = scenario.user_last_name ?? defaultCopy.user_last_name;
    this.budgetLimit = scenario.budget_limit ?? defaultCopy.budget_limit;
    this.longContext = longContext;
  }

  authenticateTravel(
    _clientId: string,
    _clientSecret: string,
    _refreshToken: string,
    grantType: string,
    userFirstName: string,
    userLastName: string
  ): Record<string, unknown> {
    this.tokenExpiresIn = 2;
    this.accessToken = String(this._random.randInt(100_000, 999_999));
    this.tokenType = "Bearer";
    this.tokenScope = grantType;
    this.userFirstName = userFirstName;
    this.userLastName = userLastName;
    return {
      expires_in: 2,
      access_token: this.accessToken,
      token_type: "Bearer",
      scope: grantType,
    };
  }

  travelGetLoginStatus(): Record<string, boolean> {
    const isNotLoggedIn =
      this.tokenExpiresIn === undefined || this.tokenExpiresIn === 0;
    return { status: !isNotLoggedIn };
  }

  getBudgetFiscalYear(
    _lastModifiedAfter?: string,
    _includeRemoved?: string
  ): Record<string, string> {
    return { budget_fiscal_year: "2018" };
  }

  registerCreditCard(
    accessToken: string,
    cardNumber: string,
    expirationDate: string,
    cardholderName: string,
    cardVerificationNumber: number
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === undefined) {
      return { error: "Token not initialized" };
    }
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }
    if (cardNumber in this.creditCardList) {
      return { error: "Card already registered" };
    }

    const cardId = String(
      this._random.randInt(100_000_000_000, 999_999_999_999)
    );
    this.creditCardList[cardId] = {
      card_number: cardNumber,
      expiration_date: expirationDate,
      cardholder_name: cardholderName,
      card_verification_number: cardVerificationNumber,
      balance: this._random.randInt(10_000, 99_999),
    };
    return { card_id: cardId };
  }

  getFlightCost(
    travelFrom: string,
    travelTo: string,
    travelDate: string,
    travelClass: string
  ): Record<string, number[]> {
    const key = `${travelFrom}|${travelTo}`;
    const baseCost = BASE_COSTS.get(key);

    if (baseCost === undefined) {
      throw new Error("No available route for the given airports.");
    }

    let factor = 1;
    if (travelClass === "economy") {
      factor = 1;
    } else if (travelClass === "business") {
      factor = 2;
    } else if (travelClass === "first") {
      factor = 5;
    } else {
      throw new Error(
        "Invalid travel class. Options are: economy, business, first."
      );
    }

    const digitSum = travelDate
      .split("")
      .filter((c) => /\d/.test(c))
      .reduce((sum, c) => sum + Number.parseInt(c, 10), 0);
    const travelDateMultiplier = digitSum % 2 === 0 ? 2 : 1;

    const travelCost = baseCost * factor * travelDateMultiplier;

    const travelCostList: number[] = [];
    if (this.longContext) {
      this._flightCostLookup.clear();
      for (const [route, base] of BASE_COSTS.entries()) {
        const cost = base * factor * travelDateMultiplier;
        const [from, to] = route.split("|");
        const cacheKey = `${from}|${to}|${travelClass}|${travelDate}`;
        this._flightCostLookup.set(cacheKey, { cost });
        travelCostList.push(cost);
      }
    } else {
      travelCostList.push(travelCost);
      const cacheKey = `${travelFrom}|${travelTo}|${travelClass}|${travelDate}`;
      this._flightCostLookup.set(cacheKey, { cost: travelCost });
    }

    return { travel_cost_list: travelCostList };
  }

  getCreditCardBalance(
    accessToken: string,
    cardId: string
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }
    if (!(cardId in this.creditCardList)) {
      return {
        error: `Card not registered. Here are a list of card_id's: ${Object.keys(this.creditCardList).join(", ")}`,
      };
    }
    return { card_balance: this.creditCardList[cardId].balance };
  }

  bookFlight(
    accessToken: string,
    cardId: string,
    travelDate: string,
    travelFrom: string,
    travelTo: string,
    travelClass: string
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { booking_status: false, error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { booking_status: false, error: "Invalid access token" };
    }
    if (!(cardId in this.creditCardList)) {
      return { booking_status: false, error: "Card not registered" };
    }
    if (!("balance" in this.creditCardList[cardId])) {
      return { booking_status: false, error: "Balance not found" };
    }

    const allAirports = this.listAllAirports();
    if (!allAirports.includes(travelFrom)) {
      return {
        booking_status: false,
        error: `Invalid departure airport code: ${travelFrom}`,
      };
    }
    if (!allAirports.includes(travelTo)) {
      return {
        booking_status: false,
        error: `Invalid destination airport code: ${travelTo}`,
      };
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(travelDate)) {
      return {
        booking_status: false,
        error: "Invalid date format. Use YYYY-MM-DD.",
      };
    }

    const validClasses = new Set(["economy", "business", "first"]);
    if (!validClasses.has(travelClass)) {
      return {
        booking_status: false,
        error: `Invalid travel class. Must be one of ${[...validClasses].join(", ")}`,
      };
    }

    try {
      this.getFlightCost(travelFrom, travelTo, travelDate, travelClass);
      const cacheKey = `${travelFrom}|${travelTo}|${travelClass}|${travelDate}`;
      const travelCostEntry = this._flightCostLookup.get(cacheKey);
      if (!travelCostEntry) {
        return {
          booking_status: false,
          error: "No available route for the given parameters",
        };
      }
      const travelCost = travelCostEntry.cost;

      if (this.creditCardList[cardId].balance < travelCost) {
        return { booking_status: false, error: "Insufficient funds" };
      }
      if (
        this.budgetLimit !== undefined &&
        this.creditCardList[cardId].balance < this.budgetLimit
      ) {
        return {
          booking_status: false,
          error: "Balance is less than budget limit",
        };
      }

      this.creditCardList[cardId].balance -= travelCost;
      const bookingId = String(this._random.randInt(1_000_000, 9_999_999));
      const transactionId = String(
        this._random.randInt(10_000_000, 99_999_999)
      );

      this.bookingRecord[bookingId] = {
        card_id: cardId,
        travel_date: travelDate,
        travel_from: travelFrom,
        travel_to: travelTo,
        travel_class: travelClass,
        travel_cost: travelCost,
        transaction_id: transactionId,
      };

      if (this.longContext) {
        return {
          booking_id: bookingId,
          transaction_id: transactionId,
          booking_status: true,
          booking_history: this.bookingRecord,
        };
      }
      return {
        booking_id: bookingId,
        transaction_id: transactionId,
        booking_status: true,
        booking_history: {},
      };
    } catch (e) {
      return { booking_status: false, error: String(e) };
    }
  }

  retrieveInvoice(
    accessToken: string,
    bookingId?: string,
    _insuranceId?: string
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }
    if (!(bookingId && bookingId in this.bookingRecord)) {
      return { error: "Booking not found" };
    }
    const booking = this.bookingRecord[bookingId];
    return {
      invoice: {
        booking_id: bookingId,
        travel_date: booking.travel_date,
        travel_from: booking.travel_from,
        travel_to: booking.travel_to,
        travel_class: booking.travel_class,
        travel_cost: booking.travel_cost,
        transaction_id: booking.transaction_id,
      },
    };
  }

  getBookingHistory(accessToken: string): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }
    return { booking_history: JSON.parse(JSON.stringify(this.bookingRecord)) };
  }

  listAllAirports(): string[] {
    return ALL_AIRPORTS;
  }

  cancelBooking(
    accessToken: string,
    bookingId: string
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { cancel_status: false, error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { cancel_status: false, error: "Invalid access token" };
    }
    if (!(bookingId in this.bookingRecord)) {
      return { cancel_status: false, error: "Booking not found" };
    }
    const cardId = this.bookingRecord[bookingId].card_id;
    const travelCost = this.bookingRecord[bookingId].travel_cost;
    this.creditCardList[cardId].balance += travelCost;
    delete this.bookingRecord[bookingId];
    return { cancel_status: true };
  }

  computeExchangeRate(
    baseCurrency: string,
    targetCurrency: string,
    value: number
  ): Record<string, number> {
    const forwardKey = `${baseCurrency}|${targetCurrency}`;
    const reverseKey = `${targetCurrency}|${baseCurrency}`;

    if (EXCHANGE_RATES.has(forwardKey)) {
      const rate = EXCHANGE_RATES.get(forwardKey)!;
      return { exchanged_value: value * rate };
    }
    if (EXCHANGE_RATES.has(reverseKey)) {
      const rate = EXCHANGE_RATES.get(reverseKey)!;
      return { exchanged_value: Math.round((value / rate) * 100) / 100 };
    }
    throw new Error("No available exchange rate for the given currencies.");
  }

  verifyTravelerInformation(
    firstName: string,
    lastName: string,
    dateOfBirth: string,
    passportNumber: string
  ): Record<string, unknown> {
    if (this.userFirstName !== firstName || this.userLastName !== lastName) {
      return {
        verification_status: false,
        verification_failure: `Cannot book flight information for another user. Expected ${this.userFirstName} ${this.userLastName}, got ${firstName} ${lastName}`,
      };
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateOfBirth)) {
      return {
        verification_status: false,
        verification_failure:
          "Invalid date of birth format. Please use YYYY-MM-DD.",
      };
    }

    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && today.getDate() < birthDate.getDate())
    ) {
      age--;
    }

    if (age < 18) {
      return {
        verification_status: false,
        verification_failure: "Traveler must be at least 18 years old.",
      };
    }

    if (!passportNumber.startsWith("US")) {
      return {
        verification_status: false,
        verification_failure: "Passport must be issued by the United States.",
      };
    }

    return { verification_status: true };
  }

  setBudgetLimit(
    accessToken: string,
    budgetLimit: number
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }
    this.budgetLimit = Number(budgetLimit);
    return { budget_limit: this.budgetLimit };
  }

  getNearestAirportByCity(location: string): Record<string, string> {
    return { nearest_airport: AIRPORT_MAP[location] ?? "Unknown" };
  }

  purchaseInsurance(
    accessToken: string,
    _insuranceType: string,
    bookingId: string,
    insuranceCost: number,
    cardId: string
  ): Record<string, unknown> {
    if (this.tokenExpiresIn === 0) {
      return { insurance_status: false, error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { insurance_status: false, error: "Invalid access token" };
    }
    if (this.budgetLimit !== undefined && this.budgetLimit < insuranceCost) {
      return { insurance_status: false, error: "Exceeded budget limit" };
    }
    if (!(bookingId in this.bookingRecord)) {
      return { insurance_status: false, error: "Booking not found" };
    }
    if (!(cardId in this.creditCardList)) {
      return { insurance_status: false, error: "Credit card not registered" };
    }
    this.creditCardList[cardId].balance -= insuranceCost;
    return {
      insurance_id: String(this._random.randInt(100_000_000, 999_999_999)),
      insurance_status: true,
    };
  }

  contactCustomerSupport(
    bookingId: string,
    _message: string
  ): Record<string, string> {
    if (!(bookingId in this.bookingRecord)) {
      return { error: "Booking not found" };
    }
    return {
      customer_support_message:
        "Thank you for contacting customer support. Your message has been received and we will get back to you shortly.",
    };
  }

  getAllCreditCards(): Record<string, unknown> {
    return { credit_card_list: this.creditCardList };
  }
}
