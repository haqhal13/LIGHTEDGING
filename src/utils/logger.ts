import chalk from "chalk";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function debug(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.DEBUG) {
    console.log(chalk.gray(`[${timestamp()}] [DEBUG]`), ...args);
  }
}

export function info(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.INFO) {
    console.log(chalk.blue(`[${timestamp()}] [INFO]`), ...args);
  }
}

export function success(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.INFO) {
    console.log(chalk.green(`[${timestamp()}] [SUCCESS]`), ...args);
  }
}

export function warn(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.WARN) {
    console.log(chalk.yellow(`[${timestamp()}] [WARN]`), ...args);
  }
}

export function error(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.ERROR) {
    console.log(chalk.red(`[${timestamp()}] [ERROR]`), ...args);
  }
}

export function trade(side: "BUY" | "SELL", ...args: unknown[]): void {
  const color = side === "BUY" ? chalk.green : chalk.red;
  console.log(color(`[${timestamp()}] [TRADE] [${side}]`), ...args);
}

export function paper(...args: unknown[]): void {
  console.log(chalk.magenta(`[${timestamp()}] [PAPER]`), ...args);
}

export default {
  debug,
  info,
  success,
  warn,
  error,
  trade,
  paper,
  setLogLevel,
};
