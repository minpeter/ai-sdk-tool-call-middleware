export interface MessageScenario {
  random_seed?: number;
  generated_ids?: number[];
  user_count?: number;
  user_map?: Record<string, string>;
  inbox?: Record<string, string>[];
  message_count?: number;
  current_user?: string | null;
}

const DEFAULT_STATE: MessageScenario = {
  generated_ids: [],
  user_count: 4,
  user_map: {
    Alice: "USR001",
    Bob: "USR002",
    Catherine: "USR003",
    Daniel: "USR004",
  },
  inbox: [
    { USR002: "My name is Alice. I want to connect." },
    { USR003: "Could you upload the file?" },
    { USR004: "Could you upload the file?" },
  ],
  message_count: 3,
  current_user: null,
};

export class MessageAPI {
  private generatedIds: Set<number>;
  private userCount: number;
  private userMap: Record<string, string>;
  private inbox: Record<string, string>[];
  private currentUser: string | null;

  constructor() {
    // Initialize with defaults, will be overridden by _loadScenario
    this.generatedIds = new Set();
    this.userCount = 4;
    this.userMap = {};
    this.inbox = [];
    this.messageCount = 0;
    this.currentUser = null;
  }

  _loadScenario(scenario: MessageScenario, _longContext = false): void {
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this._random = Math.random; // Placeholder, would need proper seeding

    const generatedIdsData = scenario.generated_ids || [];
    this.generatedIds = new Set(generatedIdsData);
    this.userCount = scenario.user_count || defaultCopy.user_count;
    this.userMap = { ...defaultCopy.user_map, ...scenario.user_map };
    this.inbox = scenario.inbox || defaultCopy.inbox;
    this.messageCount = scenario.message_count || defaultCopy.message_count;
    this.currentUser = scenario.current_user || defaultCopy.current_user;
  }

  equals(other: any): boolean {
    if (!(other instanceof MessageAPI)) {
      return false;
    }

    const excludeKeys = new Set(["_random", "_apiDescription"]);
    for (const key of Object.keys(this)) {
      if (key.startsWith("_") || excludeKeys.has(key)) {
        continue;
      }
      if ((this as any)[key] !== (other as any)[key]) {
        return false;
      }
    }

    return true;
  }

  private _generateId(): Record<string, number> {
    let newId = Math.floor(Math.random() * 90_000) + 10_000; // 5 digits
    while (this.generatedIds.has(newId)) {
      newId = Math.floor(Math.random() * 90_000) + 10_000;
    }
    this.generatedIds.add(newId);
    return { new_id: newId };
  }

  listUsers(): Record<string, string[]> {
    return { user_list: Object.keys(this.userMap) };
  }

  list_users(): Record<string, string[]> {
    return this.listUsers();
  }

  getUserId(user: string): Record<string, string | null> {
    if (!(user in this.userMap)) {
      return { error: `User '${user}' not found in the workspace.` };
    }
    return { user_id: this.userMap[user] };
  }

  messageLogin(userId: string): Record<string, string | boolean> {
    if (!Object.values(this.userMap).includes(userId)) {
      return { login_status: false, message: `User ID '${userId}' not found.` };
    }
    this.currentUser = userId;
    return {
      login_status: true,
      message: `User '${userId}' logged in successfully.`,
    };
  }

  messageGetLoginStatus(): Record<string, boolean> {
    return { login_status: !!this.currentUser };
  }

  sendMessage(receiverId: string, message: string): Record<string, any> {
    if (!this.currentUser) {
      return { error: "No user is currently logged in." };
    }
    if (!Object.values(this.userMap).includes(receiverId)) {
      return { error: `Receiver ID '${receiverId}' not found.` };
    }

    const messageId = this._generateId();
    this.inbox.push({ [receiverId]: message });
    this.messageCount += 1;
    return {
      sent_status: true,
      message_id: messageId,
      message: `Message sent to '${receiverId}' successfully.`,
    };
  }

  deleteMessage(receiverId: string): Record<string, any> {
    if (!this.currentUser) {
      return { error: "No user is currently logged in." };
    }

    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const message = this.inbox[i];
      const [receiver] = Object.keys(message);
      if (receiver === receiverId) {
        this.inbox.splice(i, 1);
        return {
          deleted_status: true,
          receiver_id: receiver,
          message: `Receiver ${receiverId}'s latest message deleted successfully.`,
        };
      }
    }
    return { error: `Receiver ID ${receiverId} not found.` };
  }

  viewMessagesSent(): Record<string, any> {
    if (!this.currentUser) {
      return { error: "No user is currently logged in." };
    }

    const sentMessages: Record<string, string[]> = {};
    for (const message of this.inbox) {
      const [receiver, content] = Object.entries(message)[0];
      if (!sentMessages[receiver]) {
        sentMessages[receiver] = [];
      }
      sentMessages[receiver].push(content);
    }
    return { messages: sentMessages };
  }

  addContact(userName: string): Record<string, any> {
    if (userName in this.userMap) {
      return { error: `User name '${userName}' already exists.` };
    }
    this.userCount += 1;
    const userId = `USR${String(this.userCount).padStart(3, "0")}`;
    if (Object.values(this.userMap).includes(userId)) {
      return { error: `User ID '${userId}' already exists.` };
    }
    this.userMap[userName] = userId;
    return {
      added_status: true,
      user_id: userId,
      message: `Contact '${userName}' added successfully.`,
    };
  }

  searchMessages(keyword: string): Record<string, any> {
    if (!this.currentUser) {
      return { error: "No user is currently logged in." };
    }
    const keywordLower = keyword.toLowerCase();
    const results = [];

    for (const messageData of this.inbox) {
      const [receiverId, messageContent] = Object.entries(messageData)[0];
      if (messageContent.toLowerCase().includes(keywordLower)) {
        results.push({
          receiver_id: receiverId,
          message: messageContent,
        });
      }
    }
    return { results };
  }

  getMessageStats(): Record<string, any> {
    if (!this.currentUser) {
      return { error: "No user is currently logged in." };
    }
    const receivedCount = this.inbox.length;
    const contacts = new Set(this.inbox.map((msg) => Object.keys(msg)[0]));
    const totalContacts = contacts.size;
    return {
      stats: {
        received_count: receivedCount,
        total_contacts: totalContacts,
      },
    };
  }
}
