// Constants and class mappings for multi-turn evaluation
// Ported from executable_backend_config.py

import { GorillaFileSystem } from "./classes/gorilla-file-system";
import { MathAPI } from "./classes/math-api";
import { MessageAPI } from "./classes/message-api";
import { TicketAPI } from "./classes/ticket-api";
import { TradingBot } from "./classes/trading-bot";
import { TravelAPI } from "./classes/travel-api";
import { TwitterAPI } from "./classes/twitter-api";
import { VehicleControlAPI } from "./classes/vehicle-control-api";

// Class name to constructor mapping
export const CLASS_NAME_TO_CLASS: Record<string, any> = {
  MathAPI,
  MessageAPI,
  TicketAPI,
  TwitterAPI,
  TravelAPI,
  TradingBot,
  VehicleControlAPI,
  GorillaFileSystem,
};

// Stateless classes (don't maintain state across turns)
export const STATELESS_CLASSES = new Set(["MathAPI"]);

// Module path mapping (simplified for TypeScript)
export const CLASS_FILE_PATH_MAPPING: Record<string, string> = {
  MathAPI: "math_api",
  MessageAPI: "message_api",
  TicketAPI: "ticket_api",
  TwitterAPI: "posting_api",
  TravelAPI: "travel_booking",
  TradingBot: "trading_bot",
  VehicleControlAPI: "vehicle_control",
  GorillaFileSystem: "gorilla_file_system",
};

// Function categories for different benchmark types
export const MULTI_TURN_CATEGORY = [
  "multi_turn_base",
  "multi_turn_miss_func",
  "multi_turn_miss_param",
  "multi_turn_long_context",
];

// Configuration constants
export const BFCL_CONFIG = {
  // Add configuration constants as needed
};
