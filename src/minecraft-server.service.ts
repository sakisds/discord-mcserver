import { Injectable, Logger } from "@nestjs/common";
import { DigitalOceanService } from "./digital-ocean.service";
import { NodeSSH, SSHExecCommandResponse } from "node-ssh";
import { ConfigService } from "@nestjs/config";

export type ServerStatus = "up" | "down" | "starting" | "stopping" | "weird";

/**
 * Commands to run on a fresh droplet to make it a minecraft server
 */
const initializationScript = [
  "mkdir -p /mnt/discord_mcserver",
  "mount /dev/sda /mnt/discord_mcserver",
  "apt install openjdk-11-jre-headless -y",
  "ufw allow 25565/tcp",
  "ufw allow 25565/udp",
  "useradd --home-dir /mnt/discord_mcserver/minecraft --uid=10001 minecraft",
  "cp /mnt/discord_mcserver/minecraft.service /etc/systemd/system/minecraft.service",
  "systemctl daemon-reload",
  "systemctl enable --now minecraft.service",
];

@Injectable()
export class MinecraftServerService {
  private readonly logger = new Logger(MinecraftServerService.name);

  /** Path to SSH private key for connecting to the droplet */
  private readonly privateKeyPath: string;

  /** SSH config used for node-ssh */
  private readonly sshConfig;

  /** This function will be called upon successful creation of a new server, if it is defined */
  private creationCallback: () => void = undefined;

  /** Current status of droplet/minecraft server */
  private status: ServerStatus = "down";

  /** Droplet ID of current minecraft server */
  private dropletId: number;

  /** Public IP of droplet */
  private ipv4: string;

  constructor(
    configService: ConfigService,
    private readonly doService: DigitalOceanService,
  ) {
    this.privateKeyPath = configService.get<string>("SSH_PRIVATEKEY");
    this.sshConfig = {
      host: this.ipv4,
      username: "root",
      privateKey: this.privateKeyPath,
    };
  }

  /**
   * Creates a new minecraft server droplet
   * Works only when status is "down".
   *
   * @param callback  Function to call (optionally), when server is ready.
   * */
  public async createServer(callback: () => void = undefined) {
    if (this.status !== "down") {
      this.logger.warn("Refusing to create server when status is not 'down'.");
      return;
    }
    this.creationCallback = callback;

    // Create droplet in DO
    this.status = "starting";
    try {
      this.dropletId = await this.doService.createDroplet();
      this.logger.log(
        `Created droplet with ID ${this.dropletId}. Waiting for network...`,
      );

      // Wait until the droplet is up
      this.waitForDroplet();
    } catch (err) {
      this.logger.error("Error while creating droplet!");
      this.logger.error(err);
      this.status = "down";
    }
  }

  /** Stop currently running droplet */
  public async stopServer() {
    if (this.status !== "up" && this.status !== "weird") {
      this.logger.warn(
        "Refusing to stop server when status is not 'up'/'weird'.",
      );
      return;
    }

    this.logger.log("Stopping droplet!");
    this.status = "stopping";

    this.logger.log("Running 'systemctl stop minecraft'...");
    await this.runSSHCommand("systemctl stop minecraft", undefined, true);
    this.logger.log(`Deleting droplet with ID = ${this.dropletId}`);
    await this.doService.deleteDroplet(this.dropletId);

    this.logger.log("Server stopped!");
    this.status = "down";
  }

  /** Forcefully change the current status (for debugging) */
  public forceStatus(newStatus: ServerStatus) {
    this.logger.warn(`Forcing status to be ${newStatus}`);
    this.status = newStatus;
  }

  /** Returns the current status of the server */
  public getStatus() {
    return {
      status: this.status,
      ipv4: this.ipv4,
      dropletId: this.dropletId,
    };
  }

  /**
   * Runs a command on the droplet using SSH.
   * If you are going to run many commands, create the `ssh` connection yourself,
   * otherwise it will be created and disposed inside the method.
   */
  public async runSSHCommand(
    command: string,
    ssh: NodeSSH = undefined,
    logOutput = false,
  ): Promise<SSHExecCommandResponse> {
    // Whether to close SSH connection on the end
    let disposeSSH = false;

    // If the connection is not provided, connect now
    if (!ssh) {
      ssh = new NodeSSH();
      ssh.connect(this.sshConfig);
      disposeSSH = true;
    }

    const result = await ssh.execCommand(command);
    if (logOutput) {
      console.log(`Command: ${command}, Output:`);
      console.log(result.stdout);
      console.log(result.stderr);
    }

    // Dispose SSH connection if it was created inside this command
    if (disposeSSH) {
      ssh.dispose();
    }
    return result;
  }

  /** This function continuously runs itself until the droplet is up and accepts connections */
  private async waitForDroplet() {
    const res = await this.doService.getDroplet(this.dropletId);
    if (res.status !== "active") {
      this.logger.log(`Droplet ${this.dropletId} not active. Waiting...`);
      setTimeout(this.waitForDroplet, 5000);
      return;
    }

    if (!res.networks.v4.ip_address) {
      this.logger.log(
        `Droplet ${this.dropletId} is active but without network. Waiting...`,
      );
      setTimeout(this.waitForDroplet, 5000);
      return;
    }
    // Keep IP
    this.ipv4 = res.networks.v4.ip_address;

    // Initialise droplet with SSH
    this.initDroplet();
  }

  /** Runs the droplet initialization using SSH */
  private async initDroplet() {
    this.logger.log("Initializing droplet with SSH...");

    try {
      const ssh = new NodeSSH();
      await ssh.connect(this.sshConfig);

      // Run required commands
      for (const cmd in initializationScript) {
        this.runSSHCommand(cmd, ssh, true);
      }

      this.logger.log("Droplet initialized!");
      this.status = "up";

      if (this.creationCallback) {
        this.creationCallback();
      }
    } catch (err) {
      this.logger.error("Could not run initialization script!");
      this.logger.error(err);
      this.status = "weird";
    }
  }
}
