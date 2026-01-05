interface Ticket {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: number;
  created_by: string;
  resolution?: string;
  [key: string]: string | number | undefined;
}

export interface TicketScenario {
  ticket_queue?: Ticket[];
  ticket_counter?: number;
  current_user?: string | null;
}

const DEFAULT_STATE: TicketScenario = {
  ticket_queue: [],
  ticket_counter: 1,
  current_user: null,
};

export class TicketAPI {
  private ticketQueue: Ticket[];
  private ticketCounter: number;
  private currentUser: string | null;

  constructor() {
    this.ticketQueue = [];
    this.ticketCounter = 1;
    this.currentUser = null;
  }

  _loadScenario(scenario: TicketScenario, _longContext = false): void {
    const defaultCopy = JSON.parse(
      JSON.stringify(DEFAULT_STATE)
    ) as TicketScenario;
    this.ticketQueue = scenario.ticket_queue ?? defaultCopy.ticket_queue ?? [];
    this.ticketCounter =
      scenario.ticket_counter ?? defaultCopy.ticket_counter ?? 1;
    this.currentUser =
      scenario.current_user ?? defaultCopy.current_user ?? null;
  }

  create_ticket(
    title: string,
    description = "",
    priority = 1
  ): Ticket | { error: string } {
    if (!this.currentUser) {
      return {
        error: "User not authenticated. Please log in to create a ticket.",
      };
    }
    if (priority < 1 || priority > 5) {
      return { error: "Invalid priority. Priority must be between 1 and 5." };
    }

    const ticket = {
      id: this.ticketCounter,
      title,
      description,
      status: "Open",
      priority,
      created_by: this.currentUser,
    };
    this.ticketQueue.push(ticket);
    this.ticketCounter += 1;
    return ticket;
  }

  get_ticket(ticket_id: number): Ticket | { error: string } {
    const ticket = this._findTicket(ticket_id);
    if (!ticket) {
      return { error: `Ticket with ID ${ticket_id} not found.` };
    }
    return ticket;
  }

  close_ticket(ticket_id: number): Record<string, string> {
    const ticket = this._findTicket(ticket_id);
    if (!ticket) {
      return { error: `Ticket with ID ${ticket_id} not found.` };
    }
    if (ticket.status === "Closed") {
      return { error: `Ticket with ID ${ticket_id} is already closed.` };
    }
    ticket.status = "Closed";
    return { status: `Ticket ${ticket_id} has been closed successfully.` };
  }

  resolve_ticket(
    ticket_id: number,
    resolution: string
  ): Record<string, string> {
    const ticket = this._findTicket(ticket_id);
    if (!ticket) {
      return { error: `Ticket with ID ${ticket_id} not found.` };
    }
    if (ticket.status === "Resolved") {
      return { error: `Ticket with ID ${ticket_id} is already resolved.` };
    }
    ticket.status = "Resolved";
    ticket.resolution = resolution;
    return { status: `Ticket ${ticket_id} has been resolved successfully.` };
  }

  edit_ticket(
    ticket_id: number,
    updates: Record<string, string | number | null>
  ): Record<string, string> {
    const ticket = this._findTicket(ticket_id);
    if (!ticket) {
      return { error: `Ticket with ID ${ticket_id} not found.` };
    }

    const validFields = new Set(["title", "description", "status", "priority"]);
    const invalidFields = Object.keys(updates).filter(
      (field) => !validFields.has(field)
    );
    if (invalidFields.length > 0) {
      return {
        error: `Invalid fields for update: ${invalidFields.join(", ")}`,
      };
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== null) {
        ticket[key] = value;
      }
    }

    return { status: `Ticket ${ticket_id} has been updated successfully.` };
  }

  private _findTicket(ticket_id: number): Ticket | undefined {
    return this.ticketQueue.find((ticket) => ticket.id === ticket_id);
  }

  ticket_login(username: string, password: string): Record<string, boolean> {
    if (username && password) {
      this.currentUser = username;
      return { success: true };
    }
    return { success: false };
  }

  ticket_get_login_status(): Record<string, boolean> {
    return { login_status: !!this.currentUser };
  }

  logout(): Record<string, boolean> {
    if (this.currentUser) {
      this.currentUser = null;
      return { success: true };
    }
    return { success: false };
  }

  get_user_tickets(status?: string): (Ticket | { error: string })[] {
    if (!this.currentUser) {
      return [
        { error: "User not authenticated. Please log in to view tickets." },
      ];
    }

    let userTickets = this.ticketQueue.filter(
      (ticket) => ticket.created_by === this.currentUser
    );

    if (status) {
      userTickets = userTickets.filter(
        (ticket) => ticket.status.toLowerCase() === status.toLowerCase()
      );
    }

    return userTickets;
  }
}
