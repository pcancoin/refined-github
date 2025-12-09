import './pr-review-status.css';

import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import CheckIcon from 'octicons-plain-react/Check';
import XIcon from 'octicons-plain-react/X';
import CommentIcon from 'octicons-plain-react/Comment';
import batchedFunction from 'batched-function';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import observe from '../helpers/selector-observer.js';
import {openPrsListLink} from '../github-helpers/selectors.js';
import {expectToken} from '../github-helpers/github-token.js';

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

	for (const pr of prConfigs) {
		const prData = data[pr.key]?.pullRequest;
		if (!prData) {
			continue;
		}

		const reviewState: ReviewState = prData.viewerLatestReview?.state;

		// Don't show anything if there's no review or if it's dismissed
		if (!reviewState || reviewState === 'DISMISSED' || reviewState === 'PENDING') {
			continue;
		}

		// Check if badge already exists
		if (pr.link.nextElementSibling?.classList.contains('rgh-pr-review-status')) {
			continue;
		}

		// Check if there are new commits after the review
		const {viewerLatestReview, headRefOid} = prData;
		const reviewCommitOid = viewerLatestReview?.commit?.oid;
		const hasNewCommits = reviewCommitOid && headRefOid && reviewCommitOid !== headRefOid;

		const iconConfig = getReviewIconConfig(reviewState, hasNewCommits);
		if (!iconConfig) {
			continue;
		}

		pr.link.after(
			<span
				className={`rgh-pr-review-status tooltipped tooltipped-n ${iconConfig.className} ${hasNewCommits ? 'rgh-review-status-updated' : ''}`}
				aria-label={iconConfig.label}
			>
				{iconConfig.icon}
				{hasNewCommits && (
					<span className="rgh-review-status-indicator" aria-label="New commits since your review" />
				)}
			</span>,
		);
	}
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

