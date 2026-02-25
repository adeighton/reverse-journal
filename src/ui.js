import chalk from "chalk";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class PipelineUI {
  constructor() {
    this.renderedLines = 0;
    this.frame = 0;
    this.interval = null;
    this.phase = "pipeline"; // "pipeline" | "narrative" | "done"
    this.startTime = Date.now();

    this.compress = { status: "pending", count: 0 };
    this.analytics = { status: "pending" };
    this.weeks = [];
    this.months = [];
    this.quarters = [];
    this.narrative = { status: "pending" };
  }

  get isTTY() {
    return process.stdout.isTTY;
  }

  get spinner() {
    return SPINNER[this.frame % SPINNER.length];
  }

  get elapsed() {
    const sec = ((Date.now() - this.startTime) / 1000) | 0;
    if (sec < 60) return `${sec}s`;
    return `${(sec / 60) | 0}m ${sec % 60}s`;
  }

  start() {
    this.startTime = Date.now();
    if (!this.isTTY) return;
    this.interval = setInterval(() => {
      this.frame++;
      if (this.phase === "pipeline") this.render();
    }, 80);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "compress:start":
        this.compress.status = "running";
        break;
      case "compress:done":
        this.compress = { status: "done", count: event.count };
        break;
      case "analytics:start":
        this.analytics.status = "running";
        break;
      case "analytics:done":
        this.analytics.status = "done";
        break;
      case "weeks:init":
        this.weeks = event.weeks.map((w) => ({ ...w, status: "pending" }));
        break;
      case "week:start":
        this._setStatus(this.weeks, event.key, "running");
        break;
      case "week:done":
        this._setStatus(this.weeks, event.key, "done");
        break;
      case "months:init":
        this.months = event.months.map((m) => ({ ...m, status: "pending" }));
        break;
      case "month:start":
        this._setStatus(this.months, event.key, "running");
        break;
      case "month:done":
        this._setStatus(this.months, event.key, "done");
        break;
      case "quarters:init":
        this.quarters = event.quarters.map((q) => ({ ...q, status: "pending" }));
        break;
      case "quarter:start":
        this._setStatus(this.quarters, event.key, "running");
        break;
      case "quarter:done":
        this._setStatus(this.quarters, event.key, "done");
        break;
      case "narrative:start":
        this.narrative = { status: "running" };
        break;
      case "narrative:done":
        this.narrative = { status: "done" };
        this._printNarrative(event.text);
        return;
      case "save:start":
      case "save:done":
        return;
    }
    if (this.phase === "pipeline") this.render();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  render() {
    if (!this.isTTY) return;

    // Move cursor up and clear previous render
    if (this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A\x1b[0J`);
    }

    const lines = this._buildPipelineLines();
    const output = lines.join("\n") + "\n";
    this.renderedLines = lines.length;
    process.stdout.write(output);
  }

  _buildPipelineLines() {
    const W = Math.min(process.stdout.columns || 72, 72);
    const lines = [];

    // Header
    lines.push("");
    const headerText = "Reverse Journal";
    const elapsed = chalk.dim(` ${this.elapsed}`);
    const rule = "─".repeat(Math.max(0, W - headerText.length - 6));
    lines.push(`  ${chalk.bold.blue(headerText)} ${chalk.blue(rule)}${elapsed}`);
    lines.push("");

    // Compress
    lines.push(
      this._statusLine(this.compress.status,
        this.compress.status === "done"
          ? `Compressed ${this.compress.count} events`
          : "Compressing events..."),
    );

    // Analytics
    if (this.analytics.status !== "pending" || this.compress.status === "done") {
      lines.push(
        this._statusLine(this.analytics.status,
          this.analytics.status === "done"
            ? "Computed analytics + weekly baseline"
            : "Computing analytics..."),
      );
    }

    // Week summaries
    if (this.weeks.length > 0) {
      const done = this.weeks.filter((w) => w.status === "done").length;
      const running = this.weeks.filter((w) => w.status === "running").length;
      const total = this.weeks.length;
      lines.push("");

      const barWidth = 20;
      const bar = this._progressBar(done, total, barWidth);
      const countStr = chalk.dim(`${done}/${total}`);
      const label = chalk.bold("Weeks");
      lines.push(`  ${label}  ${bar} ${countStr}${running > 0 ? chalk.yellow(` ${this.spinner} ${running} in flight`) : ""}`);

      // Grid
      const colWidth = 13;
      const cols = Math.max(2, Math.floor((W - 4) / colWidth));
      for (let i = 0; i < this.weeks.length; i += cols) {
        const row = this.weeks.slice(i, i + cols);
        const cells = row.map((w) => this._cell(w.status, w.label, colWidth));
        lines.push("  " + cells.join(""));
      }
    }

    // Month summaries
    if (this.months.length > 0) {
      const done = this.months.filter((m) => m.status === "done").length;
      const total = this.months.length;
      lines.push("");

      const bar = this._progressBar(done, total, 20);
      const countStr = chalk.dim(`${done}/${total}`);
      lines.push(`  ${chalk.bold("Months")}  ${bar} ${countStr}`);

      const cells = this.months.map((m) => this._cell(m.status, m.label, 14));
      lines.push("  " + cells.join(""));
    }

    // Quarter summaries
    if (this.quarters.length > 0) {
      const done = this.quarters.filter((q) => q.status === "done").length;
      const total = this.quarters.length;
      lines.push("");

      if (total === 1) {
        lines.push(
          `  ${chalk.bold("Quarter")}  ` +
            this._cell(this.quarters[0].status, this.quarters[0].label, 14),
        );
      } else {
        const bar = this._progressBar(done, total, 20);
        const countStr = chalk.dim(`${done}/${total}`);
        lines.push(`  ${chalk.bold("Quarters")}  ${bar} ${countStr}`);
        const cells = this.quarters.map((q) => this._cell(q.status, q.label, 14));
        lines.push("  " + cells.join(""));
      }
    }

    // Narrative
    if (this.narrative.status === "running") {
      lines.push("");
      lines.push(
        this._statusLine("running", "Generating narrative..."),
      );
    }

    lines.push("");
    return lines;
  }

  _printNarrative(text) {
    this.phase = "done";
    this.stop();

    // Clear the live dashboard
    if (this.isTTY && this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A\x1b[0J`);
    }

    const W = Math.min(process.stdout.columns || 72, 72);

    // Print compact final pipeline summary
    let out = "\n";
    const rule = "─".repeat(Math.max(0, W - 18));
    out += `  ${chalk.bold.blue("Reverse Journal")} ${chalk.blue(rule)}\n`;
    out += "\n";
    out += `  ${chalk.green("✓")} Compressed ${this.compress.count} events\n`;
    out += `  ${chalk.green("✓")} Computed analytics + weekly baseline\n`;
    if (this.weeks.length > 0) {
      out += `  ${chalk.green("✓")} ${this.weeks.length} week summaries\n`;
    }
    if (this.months.length > 0) {
      out += `  ${chalk.green("✓")} ${this.months.length} month summaries\n`;
    }
    if (this.quarters.length > 0) {
      out += `  ${chalk.green("✓")} ${this.quarters.length} quarter summaries\n`;
    }
    out += `  ${chalk.green("✓")} Narrative generated\n`;
    out += `  ${chalk.dim(`Completed in ${this.elapsed}`)}\n`;
    out += "\n";

    const narrativeRule = "─".repeat(Math.max(0, W - 14));
    out += `  ${chalk.bold.blue("Narrative")} ${chalk.blue(narrativeRule)}\n`;
    out += "\n";
    out += text + "\n";

    process.stdout.write(out);
    this.renderedLines = 0;
  }

  // ── Primitives ──────────────────────────────────────────────────────────

  _statusLine(status, text) {
    const icon =
      status === "done"
        ? chalk.green("✓")
        : status === "running"
          ? chalk.yellow(this.spinner)
          : chalk.dim("◌");
    const styled =
      status === "done"
        ? chalk.dim(text)
        : status === "running"
          ? chalk.yellow(text)
          : chalk.dim(text);
    return `  ${icon} ${styled}`;
  }

  _cell(status, label, width) {
    const icon =
      status === "done"
        ? chalk.green("✓")
        : status === "running"
          ? chalk.yellow(this.spinner)
          : chalk.dim("◌");
    const text =
      status === "done"
        ? chalk.dim(label)
        : status === "running"
          ? chalk.white.bold(label)
          : chalk.dim(label);
    // Pad based on visible character width (icon=1 + space=1 + label)
    const pad = Math.max(1, width - 2 - label.length);
    return `${icon} ${text}${" ".repeat(pad)}`;
  }

  _progressBar(done, total, width) {
    const frac = total > 0 ? done / total : 0;
    const filled = Math.round(frac * width);
    const empty = width - filled;
    return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty));
  }

  _setStatus(list, key, status) {
    const item = list.find((x) => x.key === key);
    if (item) item.status = status;
  }
}
