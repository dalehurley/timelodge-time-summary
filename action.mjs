import { appendFile } from 'node:fs/promises';

const timeEntriesUrl = 'https://timelodge.com/api/v1/time-entries';
const perPage = 100;
const maxPages = 100;

class SummaryError extends Error {}

function validateInput(date, token) {
    const parsed = new Date(date);
    if (
        !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
    ) {
        throw new SummaryError(
            'Enter a valid TimeLodge entry date in YYYY-MM-DD format.',
        );
    }
    if (!/^[!-~]+$/.test(token)) {
        throw new SummaryError(
            'Provide a TimeLodge workspace service token as a GitHub secret.',
        );
    }
}

async function getPage(date, token, page, request) {
    const url = new URL(timeEntriesUrl);
    url.search = new URLSearchParams({
        entry_date: date,
        page,
        per_page: perPage,
    });
    let response;
    try {
        response = await request(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer ' + token,
            },
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
        });
    } catch {
        throw new SummaryError(
            'Could not reach the TimeLodge API. Check availability and retry the workflow.',
        );
    }

    if (response.status === 401 || response.status === 403) {
        throw new SummaryError(
            'TimeLodge denied access. Check the workspace subscription and replace any revoked token with a token scoped to time:read.',
        );
    }
    if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = /^\d{1,5}$/.test(retryAfter ?? '')
            ? ' Wait ' + Number(retryAfter) + ' seconds before retrying.'
            : ' Retry the workflow later.';
        throw new SummaryError('TimeLodge rate limit reached.' + delay);
    }
    if (!response.ok) {
        throw new SummaryError(
            'TimeLodge could not return the time entries. Check the workspace and API availability.',
        );
    }

    try {
        return await response.json();
    } catch {
        throw new SummaryError('TimeLodge returned an unreadable response.');
    }
}

export async function summarizeDay(date, token, request = fetch) {
    validateInput(date, token);
    const entries = new Set();
    let recordedSeconds = 0;
    let billableSeconds = 0;
    let total;

    for (let page = 1; page <= maxPages; page += 1) {
        const payload = await getPage(date, token, page, request);
        const { data, meta } = payload ?? {};
        if (
            !Array.isArray(data) ||
            meta?.current_page !== page ||
            meta.per_page !== perPage ||
            !Number.isSafeInteger(meta.total) ||
            meta.total < 0 ||
            meta.last_page !== Math.max(1, Math.ceil(meta.total / perPage)) ||
            meta.last_page < page ||
            data.length !==
                Math.min(
                    perPage,
                    Math.max(0, meta.total - (page - 1) * perPage),
                )
        ) {
            throw new SummaryError(
                'TimeLodge returned an inconsistent page. Retry the workflow.',
            );
        }
        if (meta.last_page > maxPages) {
            throw new SummaryError(
                'The date exceeds the 10,000-entry reporting limit.',
            );
        }
        total ??= meta.total;
        if (meta.total !== total) {
            throw new SummaryError(
                'Time entries changed during pagination. Retry the workflow.',
            );
        }

        for (const entry of data) {
            if (
                typeof entry?.id !== 'string' ||
                entry.id === '' ||
                entries.has(entry.id) ||
                !Number.isSafeInteger(entry.duration_seconds) ||
                entry.duration_seconds < 0 ||
                typeof entry.billable !== 'boolean'
            ) {
                throw new SummaryError(
                    'TimeLodge returned an invalid or duplicate time entry. Retry the workflow.',
                );
            }
            entries.add(entry.id);
            recordedSeconds += entry.duration_seconds;
            if (entry.billable) billableSeconds += entry.duration_seconds;
        }

        if (page === meta.last_page) {
            if (!Number.isSafeInteger(recordedSeconds)) {
                throw new SummaryError(
                    'The recorded duration exceeds the reporting limit.',
                );
            }

            return {
                'entry-count': entries.size,
                'recorded-seconds': recordedSeconds,
                'billable-seconds': billableSeconds,
            };
        }
    }
}

export async function runAction(env = process.env, request = fetch) {
    if (!env.GITHUB_OUTPUT) {
        throw new SummaryError(
            'Run this action in a GitHub Actions job with GITHUB_OUTPUT available.',
        );
    }
    const result = await summarizeDay(
        env.INPUT_DATE ?? '',
        env['INPUT_API-TOKEN'] ?? '',
        request,
    );
    await appendFile(
        env.GITHUB_OUTPUT,
        Object.entries(result)
            .map(([name, value]) => name + '=' + value + '\n')
            .join(''),
    );
}

if (import.meta.main) {
    try {
        await runAction();
    } catch (error) {
        const message =
            error instanceof SummaryError
                ? error.message
                : 'Unable to write the TimeLodge summary to the job outputs.';
        console.error(message);
        process.exitCode = 1;
    }
}
