import './pr-review-status.css';

import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import CheckIcon from 'octicons-plain-react/Check';
import XIcon from 'octicons-plain-react/X';
import CommentIcon from 'octicons-plain-react/Comment';
import EyeIcon from 'octicons-plain-react/Eye';
import FileDiffIcon from 'octicons-plain-react/FileDiff';
import batchedFunction from 'batched-function';
import {closestElement, elementExists} from 'select-dom';
import cx from 'clsx';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import observe from '../helpers/selector-observer.js';
import {openPrsListLink} from '../github-helpers/selectors.js';
import {getLoggedInUser} from '../github-helpers/index.js';
import {withTooltipRef} from '../components/tooltip.js';

type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
type ActiveReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';

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
};

type PrReviewData = {
	isDraft: boolean;
	title: string;
	author?: {login: string};
	reviews: {nodes: Array<{state: string; author?: {login: string}}>};
	reviewThreads: {nodes: Array<{isResolved: boolean}>};
	latestReviews: {nodes: Array<{state: string; commit?: {oid: string}}>};
	viewerLatestReview?: {
		state: ReviewState;
		commit?: {oid: string};
	};
	headRefOid: string;
};

function getReviewIconConfig(reviewState: ActiveReviewState, hasNewCommits: boolean): ReviewIconConfig {
	switch (reviewState) {
		case 'APPROVED': {
			return {
				icon: <CheckIcon className="v-align-middle" />,
				label: hasNewCommits ? 'You approved this PR (new commits since review)' : 'You approved this PR',
			};
		}

		case 'CHANGES_REQUESTED': {
			return {
				icon: <XIcon className="v-align-middle" />,
				label: hasNewCommits ? 'You requested changes on this PR (new commits since review)' : 'You requested changes on this PR',
			};
		}

		case 'COMMENTED': {
			return {
				icon: <CommentIcon className="v-align-middle" />,
				label: hasNewCommits ? 'You commented on this PR (new commits since review)' : 'You commented on this PR',
			};
		}
	}
}

function getApprovalCount(reviews: PrReviewData['reviews']): number {
	const distinctApprovers = new Set<string>();
	for (const review of reviews.nodes) {
		// Author can be null for deleted accounts
		if (review.state === 'APPROVED' && review.author?.login) {
			distinctApprovers.add(review.author.login);
		}
	}

	return distinctApprovers.size;
}

function isReadyToMerge(isMyPr: boolean, isDraft: boolean, reviews: PrReviewData['reviews']): boolean {
	return isMyPr && !isDraft && getApprovalCount(reviews) >= 2;
}

function needsReview(reviewState: ReviewState | undefined, isDraft: boolean, title: string): boolean {
	const titleContainsWip = title.toLowerCase().includes('wip');
	return !reviewState && !isDraft && !titleContainsWip;
}

function hasNewCommitsAfterReview(
	reviewCommitOid: string | undefined,
	headRefOid: string,
): boolean {
	return Boolean(reviewCommitOid && reviewCommitOid !== headRefOid);
}

function getRow(prLink: HTMLElement): HTMLElement | undefined {
	return closestElement([
		'.js-issue-row', // Legacy DOM
		'li', // React PR/issue lists
	], prLink);
}

function getLatestCommentOrChangesRequested(
	latestReviews: PrReviewData['latestReviews'],
): {state: string; commitOid: string | undefined} | undefined {
	for (const review of latestReviews.nodes) {
		if (review.state === 'COMMENTED' || review.state === 'CHANGES_REQUESTED') {
			return {
				state: review.state,
				// Commit can be null if the reviewed commit was force-pushed away
				commitOid: review.commit?.oid,
			};
		}
	}

	return undefined;
}

function createToMergeBadge(approvalCount: number, hasOpenConversations: boolean): JSX.Element {
	return (
		<span
			ref={withTooltipRef({
				label: `Ready to merge (${approvalCount} approvals)${hasOpenConversations ? ' - Open conversations' : ''}`,
				direction: 'w',
			})}
			className="rgh-pr-review-status rgh-review-status-to-merge"
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
				<span className="rgh-review-status-indicator" />
			)}
		</span>
	);
}

function createFeedbackBadge(isChangesRequested: boolean): JSX.Element {
	return (
		<span
			ref={withTooltipRef({
				label: isChangesRequested ? 'Changes requested on your PR' : 'Comment on your PR',
				direction: 'w',
			})}
			className="rgh-pr-review-status rgh-review-status-feedback"
		>
			<FileDiffIcon className="v-align-middle" />
		</span>
	);
}

function createNeededBadge(): JSX.Element {
	return (
		<span
			ref={withTooltipRef({label: 'Review needed', direction: 'w'})}
			className="rgh-pr-review-status rgh-review-status-needed"
		>
			<EyeIcon className="v-align-middle" />
		</span>
	);
}

function createReviewedBadge(reviewState: ActiveReviewState, hasNewCommits: boolean): JSX.Element {
	const iconConfig = getReviewIconConfig(reviewState, hasNewCommits);
	return (
		<span
			ref={withTooltipRef({label: iconConfig.label, direction: 'w'})}
			className={cx(
				'rgh-pr-review-status',
				hasNewCommits ? 'rgh-review-status-updated' : 'rgh-review-status-reviewed',
			)}
		>
			{iconConfig.icon}
			{hasNewCommits && (
				<span className="rgh-review-status-indicator" />
			)}
		</span>
	);
}

function createOwnPrBadge(prData: PrReviewData): JSX.Element | undefined {
	const {isDraft, reviews, reviewThreads, latestReviews, headRefOid} = prData;

	if (isReadyToMerge(true, isDraft, reviews)) {
		const hasOpenConversations = reviewThreads.nodes.some(thread => !thread.isResolved);
		return createToMergeBadge(getApprovalCount(reviews), hasOpenConversations);
	}

	if (isDraft) {
		return undefined;
	}

	const latestCommentOrChanges = getLatestCommentOrChangesRequested(latestReviews);
	if (!latestCommentOrChanges || hasNewCommitsAfterReview(latestCommentOrChanges.commitOid, headRefOid)) {
		return undefined;
	}

	return createFeedbackBadge(latestCommentOrChanges.state === 'CHANGES_REQUESTED');
}

function createReviewBadge(prData: PrReviewData, loggedInUser: string | undefined): JSX.Element | undefined {
	// Author can be null for deleted accounts
	const isMyPr = prData.author?.login === loggedInUser;
	if (isMyPr) {
		return createOwnPrBadge(prData);
	}

	// Missing when the viewer has never reviewed
	const reviewState = prData.viewerLatestReview?.state;
	if (needsReview(reviewState, prData.isDraft, prData.title)) {
		return createNeededBadge();
	}

	if (!reviewState || reviewState === 'DISMISSED' || reviewState === 'PENDING') {
		return undefined;
	}

	// Commit can be null if the reviewed commit was force-pushed away
	const reviewCommitOid = prData.viewerLatestReview!.commit?.oid;
	const hasNewCommits = hasNewCommitsAfterReview(reviewCommitOid, prData.headRefOid);
	return createReviewedBadge(reviewState, hasNewCommits);
}

async function addReviewStatus(links: HTMLAnchorElement[]): Promise<void> {
	const prConfigs: PrConfig[] = links
		.filter(link => {
			const row = getRow(link);
			return row && !elementExists('.rgh-pr-review-status', row);
		})
		.map(link => {
			const [, owner, name, , prNumber] = link.pathname.split('/', 5);
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
		// Repository/PR can be missing when the query key fails or the PR was deleted
		const prData = data[pr.key]?.pullRequest as PrReviewData | undefined;
		if (!prData) {
			continue;
		}

		if (pr.link.previousElementSibling?.classList.contains('rgh-pr-review-status')) { // Sibling may be missing before the badge is inserted
			continue;
		}

		const badge = createReviewBadge(prData, loggedInUser);
		if (badge) {
			pr.link.before(badge);
		}
	}
}

async function init(signal: AbortSignal): Promise<void> {
	observe(openPrsListLink, batchedFunction(addReviewStatus, {delay: 100}), {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isIssueOrPRList,
	],
	requiresToken: true,
	init,
});

/*
Test URLs:
https://github.com/pulls
https://github.com/refined-github/refined-github/pulls
https://github.com/refined-github/sandbox/pulls
https://github.com/refined-github/sandbox/issues?q=is%3Apr+is%3Aopen
*/
