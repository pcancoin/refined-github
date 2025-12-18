import './pr-review-status.css';

import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import CheckIcon from 'octicons-plain-react/Check';
import XIcon from 'octicons-plain-react/X';
import CommentIcon from 'octicons-plain-react/Comment';
import EyeIcon from 'octicons-plain-react/Eye';
import FileDiffIcon from 'octicons-plain-react/FileDiff';
import batchedFunction from 'batched-function';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import observe from '../helpers/selector-observer.js';
import {openPrsListLink} from '../github-helpers/selectors.js';
import {expectToken} from '../github-helpers/github-token.js';
import {getLoggedInUser} from '../github-helpers/index.js';

type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | undefined;

type PrConfig = {
	key: string;
	link: HTMLAnchorElement;
	owner: string;
	name: string;
	number: number;
};

type ReviewIconConfig = {
	icon: JSX.Element;
	label: string;
	className: string;
};

function getReviewIconConfig(reviewState: ReviewState, hasNewCommits: boolean): ReviewIconConfig | undefined {
	switch (reviewState) {
		case 'APPROVED': {
			return {
				icon: <CheckIcon className="v-align-middle" />,
				label: hasNewCommits ? 'You approved this PR (new commits since review)' : 'You approved this PR',
				className: 'rgh-review-status-approved',
			};
		}

		case 'CHANGES_REQUESTED': {
			return {
				icon: <XIcon className="v-align-middle" />,
				label: hasNewCommits ? 'You requested changes on this PR (new commits since review)' : 'You requested changes on this PR',
				className: 'rgh-review-status-changes',
			};
		}

		case 'COMMENTED': {
			return {
				icon: <CommentIcon className="v-align-middle" />,
				label: hasNewCommits ? 'You commented on this PR (new commits since review)' : 'You commented on this PR',
				className: 'rgh-review-status-commented',
			};
		}

		default: {
			return undefined;
		}
	}
}

function getApprovalCount(reviews: {nodes: Array<{state: string; author?: {login: string}}>} | undefined): number {
	if (!reviews?.nodes) {
		return 0;
	}

	// Count distinct reviewers who approved
	const distinctApprovers = new Set<string>();
	for (const review of reviews.nodes) {
		if (review.state === 'APPROVED' && review.author?.login) {
			distinctApprovers.add(review.author.login);
		}
	}

	return distinctApprovers.size;
}

function isReadyToMerge(
	isMyPr: boolean,
	isDraft: boolean,
	reviews: {nodes: Array<{state: string; author?: {login: string}}>} | undefined,
): boolean {
	return isMyPr && !isDraft && getApprovalCount(reviews) >= 2;
}

function needsReview(
	reviewState: ReviewState | undefined,
	isDraft: boolean,
	title: string,
): boolean {
	const titleContainsWip = title.toLowerCase().includes('wip');
	return !reviewState && !isDraft && !titleContainsWip;
}

function hasNewCommitsAfterReview(
	reviewCommitOid: string | undefined,
	headRefOid: string | undefined,
): boolean {
	return Boolean(reviewCommitOid && headRefOid && reviewCommitOid !== headRefOid);
}

function getLatestCommentOrChangesRequested(
	latestReviews: {nodes: Array<{state: string; commit?: {oid: string}}>} | undefined,
): {state: string; commitOid: string | undefined} | undefined {
	if (!latestReviews?.nodes) {
		return undefined;
	}

	// Find the most recent COMMENTED or CHANGES_REQUESTED review
	for (const review of latestReviews.nodes) {
		if (review.state === 'COMMENTED' || review.state === 'CHANGES_REQUESTED') {
			return {
				state: review.state,
				commitOid: review.commit?.oid,
			};
		}
	}

	return undefined;
}

async function addReviewStatus(links: HTMLAnchorElement[]): Promise<void> {
	const prConfigs: PrConfig[] = links
		.filter(link => {
			// Skip if already processed
			const row = link.closest('.js-issue-row');
			return row && !row.querySelector('.rgh-pr-review-status');
		})
		.map(link => {
			const [, owner, name, , prNumber] = link.pathname.split('/');
			const key = api.escapeKey(owner, name, prNumber);
			return {
				key,
				link,
				owner,
				name,
				number: Number(prNumber),
			};
		});

	if (prConfigs.length === 0) {
		return;
	}

	// Batch queries cannot be exported to .gql files
	const batchQuery = prConfigs.map(({key, owner, name, number}) => `
		${key}: repository(owner: "${owner}", name: "${name}") {
			pullRequest(number: ${number}) {
				headRefOid
				isDraft
				title
				author {
					login
				}
				reviews(states: APPROVED, first: 10) {
					nodes {
						state
						author {
							login
						}
					}
				}
				reviewThreads(first: 10) {
					nodes {
						isResolved
					}
				}
				latestReviews(first: 10) {
					nodes {
						state
						commit {
							oid
						}
					}
				}
				viewerLatestReview {
					state
					commit {
						oid
					}
				}
			}
		}
	`).join('\n');

	const data = await api.v4(batchQuery);
	const loggedInUser = getLoggedInUser();

	for (const pr of prConfigs) {
		const prData = data[pr.key]?.pullRequest;
		if (!prData) {
			continue;
		}

		// Check if badge already exists
		if (pr.link.nextElementSibling?.classList.contains('rgh-pr-review-status')) {
			continue;
		}

		const badge = createReviewBadge(prData, loggedInUser);
		if (badge) {
			pr.link.after(badge);
		}
	}
}

function createReviewBadge(
	prData: {
		isDraft: boolean;
		title: string;
		author?: {login: string};
		reviews?: {nodes: Array<{state: string; author?: {login: string}}>};
		reviewThreads?: {nodes: Array<{isResolved: boolean}>};
		latestReviews?: {nodes: Array<{state: string; commit?: {oid: string}}>};
		viewerLatestReview?: {
			state: ReviewState;
			commit?: {oid: string};
		};
		headRefOid: string;
	},
	loggedInUser: string | undefined,
): JSX.Element | undefined {
	const reviewState = prData.viewerLatestReview?.state;
	const {isDraft, title, author, reviews, latestReviews, viewerLatestReview, headRefOid} = prData;
	const isMyPr = author?.login === loggedInUser;

	// Check if PR is ready to merge (my PR with at least 2 approvals)
	if (isReadyToMerge(isMyPr, isDraft, reviews)) {
		const approvalCount = getApprovalCount(reviews);
		const {reviewThreads} = prData;
		const hasOpenConversations = reviewThreads?.nodes?.some((thread: {isResolved: boolean}) => !thread.isResolved) ?? false;
		return (
			<span
				className="rgh-pr-review-status tooltipped tooltipped-n rgh-review-status-to-merge"
				aria-label={`Ready to merge (${approvalCount} approvals)${hasOpenConversations ? ' - Open conversations' : ''}`}
			>
				<img
					src={chrome.runtime.getURL('assets/merge-parrot.gif')}
					alt=""
					style={{
						height: '16px',
						width: '16px',
					}}
				/>
				{hasOpenConversations && (
					<span className="rgh-review-status-indicator" aria-label="Open conversations" />
				)}
			</span>
		);
	}

	// Check if someone commented or requested changes on my PR (and I haven't made changes since)
	if (isMyPr && !isDraft) {
		const latestCommentOrChanges = getLatestCommentOrChangesRequested(latestReviews);
		if (latestCommentOrChanges) {
			const hasNewCommits = hasNewCommitsAfterReview(latestCommentOrChanges.commitOid, headRefOid);
			if (!hasNewCommits) {
				const isChangesRequested = latestCommentOrChanges.state === 'CHANGES_REQUESTED';
				return (
					<span
						className="rgh-pr-review-status tooltipped tooltipped-n rgh-review-status-feedback"
						aria-label={isChangesRequested ? 'Changes requested on your PR' : 'Comment on your PR'}
					>
						<FileDiffIcon className="v-align-middle" />
					</span>
				);
			}
		}
	}

	// Skip if this is your own PR (already handled above)
	if (isMyPr) {
		return undefined;
	}

	// Check if review is needed (no review, not draft, title doesn't contain WIP)
	if (needsReview(reviewState, isDraft, title)) {
		return (
			<span
				className="rgh-pr-review-status tooltipped tooltipped-n rgh-review-status-needed"
				aria-label="Review needed"
			>
				<EyeIcon className="v-align-middle" />
			</span>
		);
	}

	// Don't show anything if there's no review or if it's dismissed
	if (!reviewState || reviewState === 'DISMISSED' || reviewState === 'PENDING') {
		return undefined;
	}

	// Check if there are new commits after the review
	const reviewCommitOid = viewerLatestReview?.commit?.oid;
	const hasNewCommits = hasNewCommitsAfterReview(reviewCommitOid, headRefOid);

	const iconConfig = getReviewIconConfig(reviewState, hasNewCommits);
	if (!iconConfig) {
		return undefined;
	}

	// Use orange if changes made since review, green otherwise
	const statusClassName = hasNewCommits ? 'rgh-review-status-updated' : 'rgh-review-status-reviewed';

	return (
		<span
			className={`rgh-pr-review-status tooltipped tooltipped-n ${statusClassName}`}
			aria-label={iconConfig.label}
		>
			{iconConfig.icon}
			{hasNewCommits && (
				<span className="rgh-review-status-indicator" aria-label="New commits since your review" />
			)}
		</span>
	);
}

async function init(signal: AbortSignal): Promise<void> {
	await expectToken();
	observe(openPrsListLink, batchedFunction(addReviewStatus, {delay: 100}), {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isIssueOrPRList,
	],
	init,
});

/*
Test URLs:
https://github.com/pulls
https://github.com/refined-github/refined-github/pulls
https://github.com/refined-github/sandbox/pulls
*/

