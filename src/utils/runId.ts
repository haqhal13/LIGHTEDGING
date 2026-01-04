/**
 * Run ID Generator
 * Creates a unique identifier for each bot run
 */

let runId: string | null = null;

/**
 * Get or create the current run ID
 * Format: YYYYMMDD-HHMMSS (e.g., 20241224-143022)
 */
export function getRunId(): string {
    if (!runId) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');

        runId = `${year}${month}${day}-${hour}${minute}${second}`;
    }
    return runId;
}

/**
 * Reset run ID (for testing or new run)
 */
export function resetRunId(): void {
    runId = null;
}
