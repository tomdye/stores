import { Query } from '../query/interfaces';
import Promise from '@dojo/shim/Promise';
import WeakMap from '@dojo/shim/WeakMap';
import Map from '@dojo/shim/Map';
import { duplicate } from '@dojo/core/lang';
import compose, { ComposeFactory } from '@dojo/compose/compose';
import { Observer, Observable } from '@dojo/core/Observable';
import Patch, { diff, PatchMapEntry } from '../patch/Patch';
import _createStoreObservable, { StoreObservable } from './createStoreObservable';
import InMemoryStorage, { Storage, FetchResult } from '../storage/InMemoryStorage';

export const enum StoreOperation {
	Add,
	Put,
	Patch,
	Delete
}

export interface StoreOptions<T, O extends CrudOptions> {
	data?: T[];
	idProperty?: keyof T;
	idFunction?: (item: T) => string;
	storage?: Storage<T, O>;
}

export interface CrudOptions {
	rejectOverwrite?: boolean;
	id?: string;
}

export type CrudArgument<T> = T | string | PatchMapEntry<T, T>;

export interface UpdateResults<T> {
	currentItems?: T[];
	failedData?: CrudArgument<T>[];
	successfulData: T[] | string[];
	type: StoreOperation;
}

export type BasicPatch = {
	id: string;
	[index: string]: any;
}

export type PatchArgument<T> = Map<string, Patch<T, T>> |
	{ id: string; patch: Patch<T, T> } |
	{ id: string; patch: Patch<T, T> }[] |
	BasicPatch |
	BasicPatch[];

export interface Store<T, O extends CrudOptions, U extends UpdateResults<T>> {
	get(ids: string[]): Promise<T[]>;
	get(id: string): Promise<T | undefined>;
	get(ids: string | string[]): Promise<T | undefined | T[]>;
	identify(items: T[]): string[];
	identify(items: T): string;
	identify(items: T | T[]): string | string[];
	createId(): Promise<string>;
	add(items: T[] | T, options?: O): StoreObservable<T, U>;
	put(items: T[] | T, options?: O): StoreObservable<T, U>;
	patch(updates: PatchArgument<T>, options?: O): StoreObservable<T, U>;
	delete(ids: string[] | string): StoreObservable<string, U>;
	fetch(query?: Query<T>): FetchResult<T>;
}

export interface StoreFactory extends ComposeFactory<Store<{}, {}, any>, StoreOptions<{}, {}>> {
	<T extends {}, O extends CrudOptions>(options?: StoreOptions<T, O>): Store<T, O, UpdateResults<T>>;
}

interface BaseStoreState<T, O, U> {
	storage: Storage<T, O>;
	initialAddPromise: Promise<any>;
}

const instanceStateMap = new WeakMap<Store<{}, {}, any>, BaseStoreState<{}, {}, any>>();

function isPatchArray(patches: any[]): patches is { id: string; patch: Patch<any, any>}[] {
	return isPatch(patches[0]);
}

function isPatch(patchObj: any): patchObj is {id: string; patch: Patch<any, any> } {
	const patch = patchObj && patchObj.patch;
	const id = patchObj && patchObj.id;
	return typeof id === 'string' && patch && Array.isArray(patch.operations) && typeof patch.apply === 'function' &&
		typeof patch.toString === 'function';
}

function createStoreObservable(storeResultsPromise: Promise<UpdateResults<{}>>) {

	return _createStoreObservable(
		new Observable<UpdateResults<{}>>(function subscribe(observer: Observer<UpdateResults<{}>>) {
			storeResultsPromise
				.then(function(results) {
					observer.next(results);
					observer.complete();
				}, function(error) {
					observer.error(error);
				});
		}),
		function(results: UpdateResults<{}>) {
			return results.successfulData;
		}
	);
}

const createStore: StoreFactory = compose<Store<{}, {}, any>, StoreOptions<{}, {}>>({
	get(this: Store<{}, {}, any>, ids: string[] | string): Promise<{}[] | {}> {
		const state = instanceStateMap.get(this);
		return state.initialAddPromise.then(function() {
			if (Array.isArray(ids)) {
				return state.storage.get(ids).then((items) => items.filter((item) => Boolean(item)));
			}
			else {
				return state.storage.get([ids]).then(items => items[0]);
			}
		});
	},

	add(this: Store<{}, {}, any>, items: {}[] | {}, options?: CrudOptions) {
		const self = this;
		const state = instanceStateMap.get(self);
		const storeResultsPromise = state.initialAddPromise.then(function() {
			return state.storage.add(Array.isArray(items) ? items : [ items ], options);
		});
		return createStoreObservable(storeResultsPromise);
	},

	put(this: Store<{}, {}, any>, items: {}[] | {}, options?: CrudOptions) {
		const self = this;
		const state = instanceStateMap.get(self);
		const storeResultsPromise = state.initialAddPromise.then(function() {
			return state.storage.put(Array.isArray(items) ? items : [ items ], options);
		});

		return createStoreObservable(storeResultsPromise);
	},

	patch(this: Store<{}, {}, any>, updates: PatchArgument<{}>, options?: CrudOptions) {
		const self = this;
		const state = instanceStateMap.get(self);
		let patchEntries: PatchMapEntry<{}, {}>[] = [];
		if (Array.isArray(updates)) {
			if (isPatchArray(updates)) {
				patchEntries = updates;
			}
			else {
				patchEntries = self.identify(updates).map((id, index) => {
					return { id: id, patch: diff(updates[index])};
				});
			}
		}
		else if (updates instanceof Map) {
			updates.forEach(function(value, key) {
				patchEntries.push({
					id: key,
					patch: value
				});
			});
		}
		else if (isPatch(updates)) {
			patchEntries = [ updates ];
		}
		else {
			const dupe = duplicate(updates);
			const idInOptions = (options && options.id);
			const id = idInOptions || dupe.id;
			if (!idInOptions) {
				delete dupe.id;
			}
			patchEntries = [ { id: id, patch: diff(dupe) }];
		}

		const storeResultsPromise = state.initialAddPromise.then(function() {
			return state.storage.patch(patchEntries);
		});

		return createStoreObservable(storeResultsPromise);
	},

	delete(this: Store<{}, {}, any>, ids: string | string[]) {
		const self = this;
		const state = instanceStateMap.get(self);
		const storeResultsPromise = state.initialAddPromise.then(function() {
			return state.storage.delete(Array.isArray(ids) ? ids : [ ids ]);
		});

		return createStoreObservable(storeResultsPromise);
	},

	fetch(this: Store<{}, {}, any>, query?: Query<{}>) {
		const state = instanceStateMap.get(this);
		let resolveTotalLength: (totalLength: number) => void;
		let rejectTotalLength: (error: any) => void;
		const totalLength = new Promise((resolve, reject) => {
			resolveTotalLength = resolve;
			rejectTotalLength = reject;
		});
		const fetchResult: FetchResult<{}> = <any> state.initialAddPromise.then(function() {
			const result = state.storage.fetch(query);
			result.totalLength.then(resolveTotalLength, rejectTotalLength);
			return result;
		});
		fetchResult.totalLength = fetchResult.dataLength = totalLength;

		return fetchResult;
	},

	identify(this: Store<{}, {}, any>, items: {}[] | {}): any {
		const storage = instanceStateMap.get(this).storage;
		if (Array.isArray(items)) {
			return storage.identify(items);
		}
		else {
			return storage.identify([items])[0];
		}
	},

	createId(this: Store<{}, {}, any>) {
		return instanceStateMap.get(this).storage.createId();
	}
}, <T, O extends CrudOptions>(instance: Store<T, O, UpdateResults<T>>, options: StoreOptions<T, O>) => {
	options = options || {};
	const data: T[] | undefined = options.data;
	options.data = undefined;
	const instanceState: BaseStoreState<T, O, UpdateResults<T>> = {
		storage: options.storage || new InMemoryStorage(options),
		initialAddPromise: Promise.resolve()
	};
	instanceStateMap.set(instance, instanceState);
	if (data) {
		instanceState.initialAddPromise = instance.add(data).catch((error) => {
			console.error(error);
		});
	}

});

export default createStore;
