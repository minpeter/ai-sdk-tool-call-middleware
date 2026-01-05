// TradingBot - Full port from Python
export interface TradingScenario {
  orders?: Record<number, OrderInfo>;
  account_info?: AccountInfo;
  authenticated?: boolean;
  market_status?: string;
  order_counter?: number;
  stocks?: Record<string, StockInfo>;
  watch_list?: string[];
  transaction_history?: TransactionInfo[];
  random_seed?: number;
}

interface OrderInfo {
  id: number;
  order_type: string;
  symbol: string;
  price: number;
  amount: number;
  status: string;
}

interface AccountInfo {
  account_id: number;
  balance: number;
  binding_card: number;
}

interface StockInfo {
  price: number;
  percent_change: number;
  volume: number;
  "MA(5)": number;
  "MA(20)": number;
}

interface TransactionInfo {
  type: string;
  amount: number;
  timestamp: string;
}

const CURRENT_TIME = new Date(2024, 8, 1, 10, 30);

const DEFAULT_STATE: TradingScenario = {
  orders: {
    12345: {
      id: 12_345,
      order_type: "Buy",
      symbol: "AAPL",
      price: 210.65,
      amount: 10,
      status: "Completed",
    },
    12446: {
      id: 12_446,
      order_type: "Sell",
      symbol: "GOOG",
      price: 2840.56,
      amount: 5,
      status: "Pending",
    },
  },
  account_info: {
    account_id: 12_345,
    balance: 10_000.0,
    binding_card: 1_974_202_140_965_533,
  },
  authenticated: false,
  market_status: "Closed",
  order_counter: 12_446,
  stocks: {
    AAPL: {
      price: 227.16,
      percent_change: 0.17,
      volume: 2.552,
      "MA(5)": 227.11,
      "MA(20)": 227.09,
    },
    GOOG: {
      price: 2840.34,
      percent_change: 0.24,
      volume: 1.123,
      "MA(5)": 2835.67,
      "MA(20)": 2842.15,
    },
    TSLA: {
      price: 667.92,
      percent_change: -0.12,
      volume: 1.654,
      "MA(5)": 671.15,
      "MA(20)": 668.2,
    },
    MSFT: {
      price: 310.23,
      percent_change: 0.09,
      volume: 3.234,
      "MA(5)": 309.88,
      "MA(20)": 310.11,
    },
    NVDA: {
      price: 220.34,
      percent_change: 0.34,
      volume: 1.234,
      "MA(5)": 220.45,
      "MA(20)": 220.67,
    },
    ALPH: {
      price: 1320.45,
      percent_change: -0.08,
      volume: 1.567,
      "MA(5)": 1321.12,
      "MA(20)": 1325.78,
    },
    OMEG: {
      price: 457.23,
      percent_change: 0.12,
      volume: 2.345,
      "MA(5)": 456.78,
      "MA(20)": 458.12,
    },
    QUAS: {
      price: 725.89,
      percent_change: -0.03,
      volume: 1.789,
      "MA(5)": 726.45,
      "MA(20)": 728.0,
    },
    NEPT: {
      price: 88.34,
      percent_change: 0.19,
      volume: 0.654,
      "MA(5)": 88.21,
      "MA(20)": 88.67,
    },
    SYNX: {
      price: 345.67,
      percent_change: 0.11,
      volume: 2.112,
      "MA(5)": 345.34,
      "MA(20)": 346.12,
    },
    ZETA: {
      price: 22.09,
      percent_change: -0.05,
      volume: 0.789,
      "MA(5)": 22.12,
      "MA(20)": 22.34,
    },
  },
  watch_list: ["NVDA"],
  transaction_history: [],
  random_seed: 1_053_520,
};

class SeededRandom {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  randint(min: number, max: number): number {
    this.seed = (this.seed * 9301 + 49_297) % 233_280;
    return Math.floor(min + (this.seed / 233_280) * (max - min + 1));
  }
}

export class TradingBot {
  private orders: Record<number, OrderInfo>;
  private accountInfo: AccountInfo;
  private authenticated: boolean;
  private marketStatus: string;
  private orderCounter: number;
  private stocks: Record<string, StockInfo>;
  private watchList: string[];
  private transactionHistory: TransactionInfo[];
  private _random: SeededRandom;

  constructor() {
    this.orders = {};
    this.accountInfo = { account_id: 0, balance: 0, binding_card: 0 };
    this.authenticated = false;
    this.marketStatus = "Closed";
    this.orderCounter = 0;
    this.stocks = {};
    this.watchList = [];
    this.transactionHistory = [];
    this._random = new SeededRandom(1_053_520);
  }

  _loadScenario(scenario: TradingScenario, longContext = false): void {
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.orders = { ...defaultCopy.orders, ...scenario.orders };
    // Convert string keys to numbers
    const convertedOrders: Record<number, OrderInfo> = {};
    for (const [k, v] of Object.entries(this.orders)) {
      const numKey = Number.parseInt(k, 10);
      if (!Number.isNaN(numKey)) {
        convertedOrders[numKey] = v;
      }
    }
    this.orders = convertedOrders;

    this.accountInfo = {
      ...defaultCopy.account_info,
      ...scenario.account_info,
    };
    this.authenticated = scenario.authenticated ?? defaultCopy.authenticated;
    this.marketStatus = scenario.market_status ?? defaultCopy.market_status;
    this.orderCounter = scenario.order_counter ?? defaultCopy.order_counter;
    this.stocks = { ...defaultCopy.stocks, ...scenario.stocks };
    this.watchList = scenario.watch_list ?? defaultCopy.watch_list;
    this.transactionHistory =
      scenario.transaction_history ?? defaultCopy.transaction_history;
    this.longContext = longContext;
    this._random = new SeededRandom(
      scenario.random_seed ?? defaultCopy.random_seed
    );
  }

  private _generateTransactionTimestamp(): string {
    const startDate = CURRENT_TIME;
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(endDate.getTime() / 1000);
    const randomTimestamp = this._random.randint(startTimestamp, endTimestamp);
    const randomDate = new Date(randomTimestamp * 1000);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${randomDate.getFullYear()}-${pad(randomDate.getMonth() + 1)}-${pad(randomDate.getDate())} ${pad(randomDate.getHours())}:${pad(randomDate.getMinutes())}:${pad(randomDate.getSeconds())}`;
  }

  equals(other: unknown): boolean {
    if (!(other instanceof TradingBot)) {
      return false;
    }
    return (
      JSON.stringify(this.orders) === JSON.stringify(other.orders) &&
      JSON.stringify(this.accountInfo) === JSON.stringify(other.accountInfo) &&
      this.authenticated === other.authenticated &&
      this.marketStatus === other.marketStatus &&
      JSON.stringify(this.watchList) === JSON.stringify(other.watchList)
    );
  }

  get_current_time(): Record<string, string> {
    const hours = CURRENT_TIME.getHours();
    const minutes = CURRENT_TIME.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    const formattedHours = hours % 12 || 12;
    const formattedMinutes = minutes.toString().padStart(2, "0");
    return { current_time: `${formattedHours}:${formattedMinutes} ${ampm}` };
  }

  get_symbol_by_name(name: string): Record<string, string> {
    const symbolMap: Record<string, string> = {
      Apple: "AAPL",
      Google: "GOOG",
      Tesla: "TSLA",
      Microsoft: "MSFT",
      Nvidia: "NVDA",
      "Zeta Corp": "ZETA",
      "Alpha Tech": "ALPH",
      "Omega Industries": "OMEG",
      "Quasar Ltd.": "QUAS",
      "Neptune Systems": "NEPT",
      "Synex Solutions": "SYNX",
      Amazon: "AMZN",
      Gorilla: "GORI",
    };
    return { symbol: symbolMap[name] ?? "Stock not found" };
  }

  get_stock_info(symbol: string): Record<string, unknown> {
    if (!(symbol in this.stocks)) {
      return { error: `Stock with symbol '${symbol}' not found.` };
    }
    return this.stocks[symbol];
  }

  get_order_details(order_id: number): Record<string, unknown> {
    const orderId = Number(order_id);
    if (!(orderId in this.orders)) {
      return {
        error: `Order with ID ${orderId} not found. Here is the list of orders_id: ${Object.keys(this.orders).join(", ")}`,
      };
    }
    return this.orders[orderId];
  }

  cancel_order(order_id: number): Record<string, unknown> {
    const orderId = Number(order_id);
    if (!(orderId in this.orders)) {
      return { error: `Order with ID ${orderId} not found.` };
    }
    if (this.orders[orderId].status === "Completed") {
      return {
        error: `Can't cancel order ${orderId}. Order is already completed.`,
      };
    }
    this.orders[orderId].status = "Cancelled";
    return { order_id: orderId, status: "Cancelled" };
  }

  place_order(
    order_type: string,
    symbol: string,
    price: number,
    amount: number
  ): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please log in to place an order.",
      };
    }
    if (!(symbol in this.stocks)) {
      return { error: `Invalid stock symbol: ${symbol}` };
    }
    if (price <= 0 || amount <= 0) {
      return { error: "Price and amount must be positive values." };
    }

    if (order_type.toLowerCase() === "buy") {
      const totalCost = Number(price) * Number(amount);
      if (totalCost > (this.accountInfo.balance ?? 0)) {
        return {
          error: `Insufficient funds: required $${totalCost.toFixed(2)} but only $${(this.accountInfo.balance ?? 0).toFixed(2)} available.`,
        };
      }
    }

    const orderId = this.orderCounter;
    this.orders[orderId] = {
      id: orderId,
      order_type,
      symbol,
      price: Number(price),
      amount: Number(amount),
      status: "Open",
    };
    this.orderCounter += 1;

    return {
      order_id: orderId,
      order_type,
      status: "Pending",
      price: Number(price),
      amount: Number(amount),
    };
  }

  withdraw_funds(amount: number): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please log in to make a transaction.",
      };
    }
    if (this.marketStatus !== "Open") {
      return { error: "Market is closed. Transactions are not allowed." };
    }
    if (amount <= 0) {
      return { error: "Transaction amount must be positive." };
    }
    if (amount > this.accountInfo.balance) {
      return { error: "Insufficient funds for withdrawal." };
    }

    this.accountInfo.balance -= amount;
    this.transactionHistory.push({
      type: "withdrawal",
      amount,
      timestamp: this._generateTransactionTimestamp(),
    });
    return {
      status: "Withdrawal successful",
      new_balance: this.accountInfo.balance,
    };
  }

  get_account_info(): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error:
          "User not authenticated. Please log in to view account information.",
      };
    }
    return this.accountInfo;
  }

  trading_login(_username: string, _password: string): Record<string, string> {
    if (this.authenticated) {
      return { status: "Already logged in" };
    }
    this.authenticated = true;
    return { status: "Logged in successfully" };
  }

  trading_get_login_status(): Record<string, boolean> {
    return { status: this.authenticated };
  }

  trading_logout(): Record<string, string> {
    if (!this.authenticated) {
      return { status: "No user is currently logged in" };
    }
    this.authenticated = false;
    return { status: "Logged out successfully" };
  }

  fund_account(amount: number): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please log in to fund the account.",
      };
    }
    if (amount <= 0) {
      return { error: "Funding amount must be positive." };
    }
    this.accountInfo.balance += amount;
    this.transactionHistory.push({
      type: "deposit",
      amount,
      timestamp: this._generateTransactionTimestamp(),
    });
    return {
      status: "Account funded successfully",
      new_balance: this.accountInfo.balance,
    };
  }

  remove_stock_from_watchlist(symbol: string): Record<string, string> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please log in to modify the watchlist.",
      };
    }
    const idx = this.watchList.indexOf(symbol);
    if (idx === -1) {
      return { error: `Stock ${symbol} not found in watchlist.` };
    }
    this.watchList.splice(idx, 1);
    return { status: `Stock ${symbol} removed from watchlist successfully.` };
  }

  get_watchlist(): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please log in to view the watchlist.",
      };
    }
    return { watchlist: this.watchList };
  }

  get_order_history(): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please log in to view order history.",
      };
    }
    return { history: Object.keys(this.orders).map(Number) };
  }

  get_transaction_history(
    start_date?: string,
    end_date?: string
  ): Record<string, unknown> {
    if (!this.authenticated) {
      return {
        error:
          "User not authenticated. Please log in to view transaction history.",
      };
    }

    const start = start_date ? new Date(start_date) : new Date(0);
    const end = end_date ? new Date(end_date) : new Date(8_640_000_000_000_000);

    const filteredHistory = this.transactionHistory.filter((t) => {
      const txDate = new Date(t.timestamp);
      return txDate >= start && txDate <= end;
    });

    return { transaction_history: filteredHistory };
  }

  get_available_stocks(sector: string): Record<string, string[]> {
    const sectorMap: Record<string, string[]> = {
      Technology: ["AAPL", "GOOG", "MSFT", "NVDA"],
      Automobile: ["TSLA", "F", "GM"],
    };
    return { stock_list: sectorMap[sector] ?? [] };
  }

  filter_stocks_by_price(
    stocks: string[],
    min_price: number,
    max_price: number
  ): Record<string, string[]> {
    const filteredStocks = stocks.filter((symbol) => {
      const stock = this.stocks[symbol];
      if (!stock) {
        return false;
      }
      return stock.price >= min_price && stock.price <= max_price;
    });
    return { filtered_stocks: filteredStocks };
  }

  add_to_watchlist(stock: string): Record<string, string[]> {
    if (!this.watchList.includes(stock) && stock in this.stocks) {
      this.watchList.push(stock);
    }
    return { watchlist: this.watchList };
  }

  notify_price_change(
    stocks: string[],
    threshold: number
  ): Record<string, string> {
    const changedStocks = stocks.filter((symbol) => {
      const stock = this.stocks[symbol];
      if (!stock) {
        return false;
      }
      return Math.abs(stock.percent_change) >= threshold;
    });

    if (changedStocks.length > 0) {
      return {
        notification: `Stocks ${changedStocks.join(", ")} have significant price changes.`,
      };
    }
    return {
      notification: "No significant price changes in the selected stocks.",
    };
  }

  // Aliases for camelCase compatibility
  placeOrder = this.place_order.bind(this);
  getAccountInfo = this.get_account_info.bind(this);
  tradingLogin = this.trading_login.bind(this);
  tradingGetLoginStatus = this.trading_get_login_status.bind(this);
  getOrderHistory = this.get_order_history.bind(this);
}
