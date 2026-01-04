// Long context extensions for multi-turn evaluation
// Ported from long_context.py

export const ORDER_DETAIL_EXTENSION = {
  company_overview: `
{symbol} is one of the most influential companies in its sector. With a global reach, {symbol} has been instrumental
in shaping its industry. From groundbreaking products to innovative services, the company has consistently delivered
high-quality offerings that resonate with both consumers and investors. Founded several decades ago, {symbol} has grown
exponentially, establishing itself as a market leader. Its extensive portfolio includes diverse products and services,
each contributing to the company's robust financial health.

The company has consistently demonstrated a commitment to innovation, regularly introducing new technologies that redefine
how consumers and businesses interact with its products. In recent years, {symbol} has placed significant emphasis on
sustainability, investing in environmentally friendly initiatives and aiming for carbon neutrality by the year 2030. This
focus has garnered support from eco-conscious consumers and institutional investors alike, further enhancing the company's
reputation and stock value.
`,
  market_analysis: `
{symbol} has maintained a strong presence in the market, consistently outperforming many of its competitors. Analysts
regard the stock as a strong buy, citing the company's steady growth trajectory, high margins, and diverse revenue streams.
Despite global economic challenges, {symbol} has continued to expand, particularly in emerging markets where it has seen
significant demand for its products.

The company operates in a highly competitive sector, with key rivals like {symbol}'s closest competitors vying for market
share. However, due to its strong brand loyalty and continuous innovation, {symbol} has remained a top choice for both
consumers and businesses. Recent quarterly reports have highlighted the company's ability to navigate challenges such as
supply chain disruptions, inflationary pressures, and shifts in consumer behavior.
`,
  technical_analysis: `
From a technical analysis perspective, {symbol} is currently trading within a key range that has attracted significant
attention from traders. The stock's 50-day moving average (MA50) and 200-day moving average (MA200) are converging,
signaling a potential breakout. Additionally, the stock's current price of $210.65 reflects a period of consolidation,
where it has been trading in a tight range between $200 and $220.

Indicators such as the Relative Strength Index (RSI) suggest that {symbol} is in neutral territory, neither overbought
nor oversold. Many traders are watching the Bollinger Bands, which have tightened in recent weeks, indicating that the
stock could experience higher volatility soon. Historical trends show that {symbol} tends to rally after earnings
announcements, especially when the company beats analysts' expectations.
`,
  financial_highlights: `
In terms of financials, {symbol} boasts impressive metrics. The company has reported consistent revenue growth over the past
five years, with a compound annual growth rate (CAGR) of over 15%. The company's net profit margins have remained high,
exceeding 20% for the past three fiscal years. This strong financial performance has allowed {symbol} to maintain a robust
balance sheet, with significant cash reserves and minimal debt.

{symbol} has also been returning value to shareholders through dividends and share buybacks. Over the past two years,
the company has repurchased over $20 billion worth of its own stock, boosting earnings per share (EPS) and increasing
shareholder value. Analysts predict that {symbol} will continue its strong financial performance, driven by new product
launches and expansion into new markets.
`,
  risks: `
Despite its strong performance, {symbol} faces several risks that could impact its future growth. One of the primary risks
is increased competition, particularly from smaller, more agile companies that are quickly gaining market share in niche
areas. Additionally, {symbol} operates in a sector that is highly sensitive to technological change, and the company
must continuously innovate to stay ahead.

Regulatory scrutiny is another concern for {symbol}, particularly in markets like the European Union, where new regulations
could affect the company's ability to operate freely. There are also concerns about potential disruptions in the global supply
chain, which could impact the company's manufacturing and distribution capabilities, leading to delays in product launches.
`,
  future_outlook: `
Looking ahead, {symbol} is poised for continued growth. The company has several new products in the pipeline, including
expansions into new markets such as artificial intelligence (AI), augmented reality (AR), and the Internet of Things (IoT).
These technologies are expected to drive demand for {symbol}'s products, particularly in the business and enterprise sectors.

{symbol} has also announced plans to expand its services division, which includes subscription-based offerings such as
cloud services, digital media, and financial technology (FinTech) solutions. These high-margin services are expected to
contribute significantly to the company's revenue in the coming years. Investors and analysts alike are optimistic about
the company's future prospects, particularly in light of its continued commitment to innovation and sustainability.
`,
  historical_performance: `
Over the past decade, {symbol} has been a standout performer in its sector, delivering consistently high returns to
shareholders. The stock has outperformed the broader market, with an annualized return of over 18% in the past 10 years.
The company's ability to navigate both market downturns and economic crises, such as the 2008 financial crisis and the
2020 COVID-19 pandemic, has made it a favorite among institutional investors.

In 2022, {symbol} saw a record-breaking year, with revenue exceeding $500 billion for the first time in its history.
This growth was driven by strong demand for the company's flagship products, as well as the rapid expansion of its services
division. Analysts expect the company to continue its strong performance, with projected revenue growth of 10% in the
next fiscal year.
`,
  sustainability_initiatives: `
{symbol} has been at the forefront of sustainability initiatives within its industry. The company has made significant
investments in renewable energy, with plans to power all of its global operations with 100% renewable energy by 2025.
{symbol} has also committed to reducing its carbon footprint, aiming to achieve carbon neutrality across its entire
supply chain by 2030.

In addition to its environmental efforts, {symbol} has implemented several initiatives to promote diversity and inclusion
within the company. These efforts have been well-received by both employees and the wider public, enhancing the company's
reputation as a socially responsible corporate entity.
`,
};

export const CREDIT_CARD_EXTENSION: Record<string, any> = {
  "1234567812345678": {
    card_number: "1234567812345678",
    expiration_date: "12/25",
    cardholder_name: "John Doe",
    card_verification_number: 123,
    balance: 5000.0,
  },
  "2345678923456789": {
    card_number: "2345678923456789",
    expiration_date: "11/24",
    cardholder_name: "Jane Smith",
    card_verification_number: 456,
    balance: 7500.0,
  },
  // ... more credit card entries (simplified for brevity)
};

export const BOOKING_RECORD_EXTENSION: Record<string, any> = {
  booking_901: {
    card_id: "1234567812345678",
    travel_date: "2024-05-21",
    travel_from: "SFO",
    travel_to: "JFK",
    travel_class: "economy",
    travel_cost: 400.0,
    transaction_id: "trans_001",
  },
  booking_902: {
    card_id: "2345678923456789",
    travel_date: "2024-06-15",
    travel_from: "LAX",
    travel_to: "ORD",
    travel_class: "business",
    travel_cost: 900.0,
    transaction_id: "trans_002",
  },
  // ... more booking records (simplified for brevity)
};

export const WATCH_LIST_EXTENSION = [
  "JHGUN",
  "LMAT",
  "YNK",
  "W",
  "XSW",
  "XZEHV",
  "R",
  "UIENW",
  "H",
  "P",
  // ... more watch list entries (truncated for brevity)
];

export const TRANSACTION_HISTORY_EXTENSION = [
  { type: "deposit", amount: 9933.53, timestamp: "2024-05-01 22:14:05.858817" },
  { type: "deposit", amount: 9084.83, timestamp: "2023-10-25 20:12:10.858830" },
  { type: "deposit", amount: 671.32, timestamp: "2023-10-04 06:33:21.858835" },
  // ... more transaction history (truncated for brevity)
];

export const MA_5_EXTENSION = [
  234.34, 212.46, 228.56, 209.19, 223.68, 242.5, 225.93, 219.47, 241.34,
  208.85,
  // ... more MA5 values (truncated for brevity)
];

export const MA_20_EXTENSION = [
  225.08, 209.54, 242.23, 200.66, 205.5, 236.61, 235.66, 244.32, 207.04,
  236.46,
  // ... more MA20 values (truncated for brevity)
];

export const TECHNOLOGY_EXTENSION = [
  "AAPL",
  "GOOG",
  "MSFT",
  "NVDA",
  "LGY",
  "HW",
  "OLMK",
  "O",
  "ZTMG",
  "BZHAI",
  // ... more technology stocks (truncated for brevity)
];

export const AUTOMOBILE_EXTENSION = [
  "TSLA",
  "F",
  "GM",
  "UNUGJ",
  "BVO",
  "OG",
  "QMQQH",
  "CP",
  "NPIGW",
  "V",
  // ... more automobile stocks (truncated for brevity)
];

export const FILES_TAIL_USED = [
  "log.txt",
  "report.txt",
  "report.csv",
  "DataSet1.csv",
  "file1.txt",
  "finance_report.txt",
  "config.py",
  "Q4_summary.doc",
  "file3.txt",
];

export const CAR_STATUS_METADATA_EXTENSION = {
  engine_specs: "V6 3.5L Twin Turbocharged Engine",
  transmission: "8-Speed Automatic",
  fuel_efficiency: "22 MPG City / 28 MPG Highway",
  safety_rating: "5-Star NHTSA Overall",
  warranty: "3-Year/36,000-Mile Bumper-to-Bumper",
  features: [
    "Adaptive Cruise Control",
    "Lane Keep Assist",
    "Blind Spot Monitoring",
  ],
};

export const INTERMEDIARY_CITIES = [
  "Denver",
  "Omaha",
  "Des Moines",
  "Minneapolis",
  "Milwaukee",
];

export const LONG_WEATHER_EXTENSION = {
  outsideTemperature: 72.5,
  humidity: 45.0,
  windSpeed: 8.2,
  precipitation: 0.0,
  visibility: 10.0,
};

export const PARKING_BRAKE_INSTRUCTION = `
WARNING: Parking brake engaged. Vehicle will not move until parking brake is released.
To release parking brake:
1. Ensure vehicle is on a flat surface
2. Press brake pedal firmly
3. Pull parking brake lever down or press release button
4. Vehicle should now be free to move
`;
