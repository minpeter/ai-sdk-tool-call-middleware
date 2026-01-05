export interface Tweet {
  id: number;
  username: string;
  content: string;
  tags: string[];
  mentions: string[];
}

export interface Comment {
  username: string;
  content: string;
}

export interface TwitterScenario {
  username?: string;
  password?: string;
  authenticated?: boolean;
  tweets?: Record<number, Tweet>;
  comments?: Record<number, Comment[]>;
  retweets?: Record<string, number[]>;
  following_list?: string[];
  tweet_counter?: number;
}

const DEFAULT_STATE: Required<TwitterScenario> = {
  username: "john",
  password: "john123",
  authenticated: false,
  tweets: {},
  comments: {},
  retweets: {},
  following_list: ["alice", "bob"],
  tweet_counter: 0,
};

export class TwitterAPI {
  private username: string;
  private password: string;
  private authenticated: boolean;
  private tweets: Record<number, Tweet>;
  private comments: Record<number, Comment[]>;
  private retweets: Record<string, number[]>;
  private followingList: string[];
  private tweetCounter: number;

  constructor() {
    this.username = "john";
    this.password = "john123";
    this.authenticated = false;
    this.tweets = {};
    this.comments = {};
    this.retweets = {};
    this.followingList = [];
    this.tweetCounter = 0;
  }

  _loadScenario(scenario: TwitterScenario, _longContext = false): void {
    const defaultCopy: Required<TwitterScenario> = JSON.parse(
      JSON.stringify(DEFAULT_STATE)
    );
    this.username = scenario.username ?? defaultCopy.username;
    this.password = scenario.password ?? defaultCopy.password;
    this.authenticated = scenario.authenticated ?? defaultCopy.authenticated;
    this.tweets = scenario.tweets ?? defaultCopy.tweets;
    // Convert tweet keys from string to int from loaded scenario
    this.tweets = Object.fromEntries(
      Object.entries(this.tweets).map(([k, v]) => [Number.parseInt(k, 10), v])
    );
    this.comments = scenario.comments ?? defaultCopy.comments;
    this.retweets = scenario.retweets ?? defaultCopy.retweets;
    this.followingList = scenario.following_list ?? defaultCopy.following_list;
    this.tweetCounter = scenario.tweet_counter ?? defaultCopy.tweet_counter;
  }

  authenticate_twitter(
    username: string,
    password: string
  ): Record<string, boolean> {
    if (username === this.username && password === this.password) {
      this.authenticated = true;
      return { authentication_status: true };
    }
    return { authentication_status: false };
  }

  posting_get_login_status(): Record<string, boolean | string> {
    return { login_status: !!this.authenticated };
  }

  post_tweet(
    content: string,
    tags: string[] = [],
    mentions: string[] = []
  ): Tweet | { error: string } {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please authenticate before posting.",
      };
    }

    const tweet = {
      id: this.tweetCounter,
      username: this.username,
      content,
      tags,
      mentions,
    };
    this.tweets[this.tweetCounter] = tweet;
    this.tweetCounter += 1;
    return tweet;
  }

  retweet(tweetId: number): Record<string, string> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please authenticate before retweeting.",
      };
    }

    if (!(tweetId in this.tweets)) {
      return { error: `Tweet with ID ${tweetId} not found.` };
    }

    if (!(this.username in this.retweets)) {
      this.retweets[this.username] = [];
    }

    if (this.retweets[this.username].includes(tweetId)) {
      return { retweet_status: "Already retweeted" };
    }

    this.retweets[this.username].push(tweetId);
    return { retweet_status: "Successfully retweeted" };
  }

  comment(tweetId: number, commentContent: string): Record<string, string> {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please authenticate before commenting.",
      };
    }

    if (!(tweetId in this.tweets)) {
      return { error: `Tweet with ID ${tweetId} not found.` };
    }

    if (!(tweetId in this.comments)) {
      this.comments[tweetId] = [];
    }

    this.comments[tweetId].push({
      username: this.username,
      content: commentContent,
    });
    return { comment_status: "Comment added successfully" };
  }

  mention(
    tweetId: number,
    mentionedUsernames: string[]
  ): Record<string, string> {
    if (!(tweetId in this.tweets)) {
      return { error: `Tweet with ID ${tweetId} not found.` };
    }

    const tweet = this.tweets[tweetId];
    tweet.mentions.push(...mentionedUsernames);

    return { mention_status: "Users mentioned successfully" };
  }

  follow_user(
    username_to_follow: string
  ): { error: string } | { follow_status: boolean } {
    if (!this.authenticated) {
      return {
        error: "User not authenticated. Please authenticate before following.",
      };
    }

    if (this.followingList.includes(username_to_follow)) {
      return { follow_status: false };
    }

    this.followingList.push(username_to_follow);
    return { follow_status: true };
  }

  list_all_following(): { error: string } | { following_list: string[] } {
    if (!this.authenticated) {
      return {
        error:
          "User not authenticated. Please authenticate before listing following.",
      };
    }
    return { following_list: this.followingList };
  }

  unfollow_user(
    username_to_unfollow: string
  ): { error: string } | { unfollow_status: boolean } {
    if (!this.authenticated) {
      return {
        error:
          "User not authenticated. Please authenticate before unfollowing.",
      };
    }

    if (!this.followingList.includes(username_to_unfollow)) {
      return { unfollow_status: false };
    }

    this.followingList = this.followingList.filter(
      (u) => u !== username_to_unfollow
    );
    return { unfollow_status: true };
  }

  get_tweet(tweet_id: number): Tweet | { error: string } {
    if (!(tweet_id in this.tweets)) {
      return { error: `Tweet with ID ${tweet_id} not found.` };
    }

    return this.tweets[tweet_id];
  }

  get_user_tweets(username: string): Tweet[] {
    return Object.values(this.tweets).filter(
      (tweet) => tweet.username === username
    );
  }

  search_tweets(keyword: string): Tweet[] {
    const keywordLower = keyword.toLowerCase();
    return Object.values(this.tweets).filter(
      (tweet) =>
        tweet.content.toLowerCase().includes(keywordLower) ||
        tweet.tags.some((tag: string) =>
          tag.toLowerCase().includes(keywordLower)
        )
    );
  }

  get_tweet_comments(tweet_id: number): (Comment | { error: string })[] {
    if (!(tweet_id in this.tweets)) {
      return [{ error: `Tweet with ID ${tweet_id} not found.` }];
    }
    return this.comments[tweet_id] || [];
  }

  get_user_stats(username: string): Record<string, number> {
    const tweetCount = Object.values(this.tweets).filter(
      (tweet) => tweet.username === username
    ).length;
    const followingCount =
      username === this.username ? this.followingList.length : 0;
    const retweetCount = (this.retweets[username] || []).length;

    return {
      tweet_count: tweetCount,
      following_count: followingCount,
      retweet_count: retweetCount,
    };
  }
}
