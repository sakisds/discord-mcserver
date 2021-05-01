import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client, Message } from "discord.js";

/** Available bot commands */
export enum BotCommand {
  PING = "ping",
  HELP = "help",
}

/** Command handler, one for each possible value of `BotCommand` */
export type CommandHandler = (message: Message) => void;

@Injectable()
export class DiscordBotService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DiscordBotService.name);

  /** Discord Bot authentication token */
  private readonly botToken: string;

  /** Channel (ID) in which the bot is allowed */
  private readonly channelId: string;

  /** Discord API client */
  private readonly client: Client;

  constructor(configService: ConfigService) {
    this.botToken = configService.get<string>("DISCORD_BOT_TOKEN");
    this.channelId = configService.get<string>("DISCORD_BOT_CHANNEL_ID");
    this.client = new Client();

    // Add event handlers
    this.client.on("message", this.messageHandler);
  }

  /** Connects to discord on application startup */
  async onApplicationBootstrap() {
    this.logger.log("Connecting to discord...");
    await this.client.login(this.botToken);
    this.logger.log("Success!");
  }

  /** Handles incoming messages and runs the appropriate commands */
  private messageHandler = (message: Message) => {
    // Only respond in configured channel
    if (message.channel.id !== this.channelId) {
      this.logger.debug("Ignoring message in wrong channel");
      return;
    }

    // Only respond for mentions
    if (!message.mentions.has(this.client.user.id)) {
      this.logger.debug("Ignoring message without a mention");
      return;
    }

    // Grab command name (regex to remove encoded mention)
    const commandString = message.content.replace(/<@!\d+>/g, "").trim();

    // Handle command
    switch (commandString as BotCommand) {
      case BotCommand.PING:
        this.pingCommand(message);
        break;
      case BotCommand.HELP:
        this.helpCommand(message);
        break;
      default:
        this.logger.log(`Ignoring unknown command ${commandString}.`);
        message.channel.send(`:warning: Unknown command "${commandString}"`);
        return;
    }
  };

  /** Responds with `pong`. */
  private pingCommand(message: Message) {
    message.channel.send("Pong!");
  }

  private helpCommand(message: Message) {
    message.channel.send(`
    **Bot commands**:
    - \`help\`: Displays this message.
    - \`ping\`: Responds with "Pong!".
    `);
  }
}