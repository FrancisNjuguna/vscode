/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { countEOL } from 'vs/editor/common/core/eolCounter';
import { IBackgroundTokenizationStore, ILanguageIdCodec } from 'vs/editor/common/languages';
import { ITextModel } from 'vs/editor/common/model';
import { ContiguousGrowingArray } from 'vs/editor/common/model/textModelTokens';
import { IModelContentChange, IModelContentChangedEvent } from 'vs/editor/common/textModelEvents';
import { ContiguousMultilineTokensBuilder } from 'vs/editor/common/tokens/contiguousMultilineTokensBuilder';
import { ArrayEdit, MonotonousIndexTransformer, SingleArrayEdit } from 'vs/workbench/services/textMate/browser/arrayOperation';
import { TextMateTokenizationWorker } from 'vs/workbench/services/textMate/browser/worker/textMate.worker';
import type { StateDeltas } from 'vs/workbench/services/textMate/browser/workerHost/textMateWorkerHost';
import { applyStateStackDiff, StateStack } from 'vscode-textmate';

export class TextMateWorkerTokenizerController extends Disposable {
	private _pendingChanges: IModelContentChangedEvent[] = [];

	/**
	 * These states will eventually equal the worker states.
	 * _states[i] stores the state at the end of line number i+1.
	 */
	private readonly _states = new ContiguousGrowingArray<StateStack | null>(null);

	constructor(
		private readonly _model: ITextModel,
		private readonly _worker: TextMateTokenizationWorker,
		private readonly _languageIdCodec: ILanguageIdCodec,
		private readonly _backgroundTokenizationStore: IBackgroundTokenizationStore,
		private readonly _initialState: StateStack,
	) {
		super();

		this._register(this._model.onDidChangeContent((e) => {
			this._worker.acceptModelChanged(this._model.uri.toString(), e);
			this._pendingChanges.push(e);
		}));

		this._register(this._model.onDidChangeLanguage((e) => {
			const languageId = this._model.getLanguageId();
			const encodedLanguageId =
				this._languageIdCodec.encodeLanguageId(languageId);
			this._worker.acceptModelLanguageChanged(
				this._model.uri.toString(),
				languageId,
				encodedLanguageId
			);
		}));

		const languageId = this._model.getLanguageId();
		const encodedLanguageId = this._languageIdCodec.encodeLanguageId(languageId);
		this._worker.acceptNewModel({
			uri: this._model.uri,
			versionId: this._model.getVersionId(),
			lines: this._model.getLinesContent(),
			EOL: this._model.getEOL(),
			languageId,
			encodedLanguageId,
		});
	}

	public override dispose(): void {
		super.dispose();
		this._worker.acceptRemovedModel(this._model.uri.toString());
	}

	/**
	 * This method is called from the worker through the worker host.
	 */
	public setTokensAndStates(versionId: number, rawTokens: ArrayBuffer, stateDeltas: StateDeltas[]): void {
		// _states state, change{k}, ..., change{versionId}, state delta base, change{j}, ..., change{m}, current renderer state
		//                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^                    ^^^^^^^^^^^^^^^^^^^^^^^^^
		//                | past changes                                       | future states

		// Apply past changes to _states
		while (
			this._pendingChanges.length > 0 &&
			this._pendingChanges[0].versionId <= versionId
		) {
			const change = this._pendingChanges.shift()!;
			const op = lineArrayEditFromModelContentChange(change.changes);
			op.applyTo(this._states);
		}

		const curToFutureTransformer1 = MonotonousIndexTransformer.fromMany(
			this._pendingChanges.map((c) => lineArrayEditFromModelContentChange(c.changes))
		);

		const tokens = ContiguousMultilineTokensBuilder.deserialize(
			new Uint8Array(rawTokens)
		);

		// Apply future changes to tokens
		for (const change of this._pendingChanges) {
			for (const innerChanges of change.changes) {
				for (let j = 0; j < tokens.length; j++) {
					tokens[j].applyEdit(innerChanges.range, innerChanges.text);
				}
			}
		}

		// Filter tokens in lines that got changed in the future to prevent flickering
		// These tokens are recomputed anyway.
		const b = new ContiguousMultilineTokensBuilder();
		for (const t of tokens) {
			for (let i = t.startLineNumber; i <= t.endLineNumber; i++) {
				const result = curToFutureTransformer1.transform(i - 1);
				if (result !== undefined) {
					b.add(i, t.getLineTokens(i) as Uint32Array);
				}
			}
		}
		this._backgroundTokenizationStore.setTokens(b.finalize());

		const curToFutureTransformer = MonotonousIndexTransformer.fromMany(
			this._pendingChanges.map((c) => lineArrayEditFromModelContentChange(c.changes))
		);

		// Apply state deltas to _states and _backgroundTokenizationStore
		for (const d of stateDeltas) {
			let prevState = d.startLineNumber <= 1 ? this._initialState : this._states.get(d.startLineNumber - 1 - 1);
			for (let i = 0; i < d.stateDeltas.length; i++) {
				const delta = d.stateDeltas[i];
				const state = applyStateStackDiff(prevState, delta)!;
				this._states.set(d.startLineNumber + i - 1, state);

				const offset = curToFutureTransformer.transform(d.startLineNumber + i - 1);
				if (offset !== undefined) {
					this._backgroundTokenizationStore.setEndState(offset + 1, state);
				}

				if (d.startLineNumber + i >= this._model.getLineCount() - 1) {
					this._backgroundTokenizationStore.backgroundTokenizationFinished();
				}

				prevState = state;
			}
		}
	}
}

function lineArrayEditFromModelContentChange(c: IModelContentChange[]): ArrayEdit {
	return new ArrayEdit(
		c.map(
			(c) =>
				new SingleArrayEdit(
					c.range.startLineNumber - 1,
					c.range.endLineNumber - c.range.startLineNumber,
					countEOL(c.text)[0]
				)
		)
	);
}
