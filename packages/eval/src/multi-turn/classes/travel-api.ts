// TravelAPI - Simplified port for core functionality
export interface TravelScenario {
  random_seed?: number;
  credit_card_list?: Record<string, any>;
  booking_record?: Record<string, any>;
  access_token?: string;
  token_type?: string;
  token_expires_in?: number;
  token_scope?: string;
  user_first_name?: string;
  user_last_name?: string;
  budget_limit?: number;
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

export class TravelAPI {
  private creditCardList: Record<string, any>;
  private bookingRecord: Record<string, any>;
  private accessToken?: string;
  private tokenType?: string;
  private tokenExpiresIn?: number;
  private tokenScope?: string;
  private userFirstName?: string;
  private userLastName?: string;
  private budgetLimit?: number;
  private longContext = false;
  private _random: any;
  private _apiDescription =
    "This tool belongs to the travel system, which allows users to book flights, manage credit cards, and view budget information.";

  constructor() {
    this.creditCardList = {};
    this.bookingRecord = {};
  }

  _loadScenario(scenario: TravelScenario, longContext = false): void {
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this._random = Math.random; // Placeholder

    this.creditCardList =
      scenario.credit_card_list || defaultCopy.credit_card_list!;
    this.bookingRecord = scenario.booking_record || defaultCopy.booking_record!;
    this.accessToken = scenario.access_token || defaultCopy.access_token;
    this.tokenType = scenario.token_type || defaultCopy.token_type;
    this.tokenExpiresIn =
      scenario.token_expires_in || defaultCopy.token_expires_in;
    this.tokenScope = scenario.token_scope || defaultCopy.token_scope;
    this.userFirstName =
      scenario.user_first_name || defaultCopy.user_first_name;
    this.userLastName = scenario.user_last_name || defaultCopy.user_last_name;
    this.budgetLimit = scenario.budget_limit || defaultCopy.budget_limit;
    this.longContext = longContext;
  }

  equals(other: any): boolean {
    if (!(other instanceof TravelAPI)) {
      return false;
    }

    // Compare all non-private attributes
    for (const key of Object.keys(this)) {
      if (key.startsWith("_") || key === "longContext") continue;
      if ((this as any)[key] !== (other as any)[key]) {
        return false;
      }
    }
    return true;
  }

  authenticateTravel(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    grantType: string,
    userFirstName: string,
    userLastName: string
  ): Record<string, any> {
    this.tokenExpiresIn = 2;
    this.accessToken = Math.random().toString(36).substring(2, 15);
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
    const isLoggedIn =
      this.tokenExpiresIn !== undefined && this.tokenExpiresIn > 0;
    return { status: isLoggedIn };
  }

  registerCreditCard(
    accessToken: string,
    cardNumber: string,
    expirationDate: string,
    cardholderName: string,
    cardVerificationNumber: number
  ): Record<string, any> {
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

    const cardId = Math.random().toString(36).substring(2, 15);
    this.creditCardList[cardId] = {
      card_number: cardNumber,
      expiration_date: expirationDate,
      cardholder_name: cardholderName,
      card_verification_number: cardVerificationNumber,
      balance: Math.floor(Math.random() * 90_000) + 10_000,
    };
    return { card_id: cardId };
  }

  getFlightCost(
    travelFrom: string,
    travelTo: string,
    travelDate: string,
    travelClass: string
  ): Record<string, number[]> {
    // Simplified flight cost calculation
    const baseCosts: Record<string, number> = {
      SFO_LAX: 200,
      SFO_JFK: 500,
      SFO_ORD: 400,
      LAX_SFO: 100,
      LAX_JFK: 600,
      // ... more routes
    };

    const key = `${travelFrom}_${travelTo}`;
    const baseCost = baseCosts[key] || 300;

    let factor = 1;
    if (travelClass === "business") factor = 2;
    else if (travelClass === "first") factor = 5;

    // Simple date multiplier
    const dateSum = travelDate
      .split("")
      .reduce((sum, char) => sum + (char.charCodeAt(0) || 0), 0);
    const travelDateMultiplier = (dateSum % 2) + 1;

    const cost = baseCost * factor * travelDateMultiplier;
    return { travel_cost_list: [cost] };
  }

  getCreditCardBalance(
    accessToken: string,
    cardId: string
  ): Record<string, any> {
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }
    if (!(cardId in this.creditCardList)) {
      const availableCards = Object.keys(this.creditCardList).join(", ");
      return {
        error:
          "Card not registered. Here are a list of card_id's: " +
          availableCards,
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
  ): Record<string, any> {
    if (this.tokenExpiresIn === 0) {
      return { booking_status: false, error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { booking_status: false, error: "Invalid access token" };
    }
    if (!(cardId in this.creditCardList)) {
      return { booking_status: false, error: "Card not registered" };
    }

    try {
      const costResult = this.getFlightCost(
        travelFrom,
        travelTo,
        travelDate,
        travelClass
      );
      const travelCost = costResult.travel_cost_list[0];

      if (this.creditCardList[cardId].balance < travelCost) {
        return { booking_status: false, error: "Insufficient funds" };
      }

      this.creditCardList[cardId].balance -= travelCost;

      const bookingId = Math.random().toString(36).substring(2, 15);
      const transactionId = Math.random().toString(36).substring(2, 15);

      this.bookingRecord[bookingId] = {
        card_id: cardId,
        travel_date: travelDate,
        travel_from: travelFrom,
        travel_to: travelTo,
        travel_class: travelClass,
        travel_cost: travelCost,
        transaction_id: transactionId,
      };

      return {
        booking_id: bookingId,
        transaction_id: transactionId,
        booking_status: true,
        booking_history: this.longContext ? this.bookingRecord : {},
      };
    } catch (e) {
      return { booking_status: false, error: String(e) };
    }
  }

  getBookingHistory(accessToken: string): Record<string, any> {
    if (this.tokenExpiresIn === 0) {
      return { error: "Token expired" };
    }
    if (accessToken !== this.accessToken) {
      return { error: "Invalid access token" };
    }

    return { booking_history: JSON.parse(JSON.stringify(this.bookingRecord)) };
  }

  // Additional methods would be implemented here...
  // For brevity, only core methods are ported
}
