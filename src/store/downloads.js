import sources from '../core/sources.js';
import { fetchChapter } from '../core/engine.js';
import { getToc, getCachedChapterIndices, saveChapters, updateBook, saveDownload } from './db.js';

const active = new Map();

export function isDownloading(bookId) { return active.has(bookId); }

export async function pauseDownload(bookId) {
	const task = active.get(bookId);
	if (!task) return;
	task.controller.abort();
	await task.promise;
}

export function downloadBook(book, { target = Infinity, onProgress } = {}) {
	if (active.has(book.id)) return active.get(book.id).promise;
	const task = { controller: new AbortController() };
	active.set(book.id, task);
	task.promise = runDownload(book, task, target, onProgress).finally(() => active.delete(book.id));
	return task.promise;
}

async function runDownload(book, task, target, onProgress) {
	// Use the saved directory so cached indices keep referring to the same chapter.
	const toc = await getToc(book.id);
	const source = sources.find((s) => s.id === book.sourceId);
	if (!toc?.length || !source) throw new Error('本地目录或书源缺失');
	const count = Math.min(toc.length, target);
	const cached = new Set(await getCachedChapterIndices(book.id));
	const queue = toc.slice(0, count).map((chapter, idx) => ({ ...chapter, idx })).filter((ch) => !cached.has(ch.idx));
	const job = { bookId: book.id, target: count, total: queue.length, completed: 0, failed: [], status: 'running' };
	const report = () => onProgress?.({ ...job, cached: cached.size });
	await saveDownload(job);
	report();
	const pauseInBackground = () => {
		if (document.visibilityState !== 'visible') task.controller.abort();
	};
	document.addEventListener('visibilitychange', pauseInBackground);
	pauseInBackground();
	try {
		async function worker() {
			while (queue.length && !task.controller.signal.aborted) {
				const chapter = queue.shift();
				try {
					const data = await fetchChapter(source, chapter.url, undefined, chapter.title, { signal: task.controller.signal });
					if (task.controller.signal.aborted) break;
					if (data.error || !data.paragraphs.length) job.failed.push(chapter.idx);
					else {
						await saveChapters(book.id, [{ ...data, idx: chapter.idx, url: chapter.url }]);
						cached.add(chapter.idx);
						job.completed++;
					}
				} catch (error) {
					if (task.controller.signal.aborted) break;
					// Persisting content must succeed before a chapter counts as downloaded.
					throw error;
				}
				report();
			}
		}
		const results = await Promise.allSettled(Array.from({ length: Math.min(2, queue.length) }, () => worker()));
		const failure = results.find((result) => result.status === 'rejected');
		if (failure) throw failure.reason;
		job.status = task.controller.signal.aborted ? 'paused' : job.failed.length ? 'partial' : 'complete';
	} catch (error) {
		job.status = 'paused';
		job.error = error.message || String(error);
	} finally {
		document.removeEventListener('visibilitychange', pauseInBackground);
		await saveDownload(job);
		await updateBook(book.id, { cachedChapters: (await getCachedChapterIndices(book.id)).length });
		report();
	}
	return job;
}
