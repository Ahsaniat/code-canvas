// Minimal ambient declarations for deps without bundled types and for Vite's
// special `?worker` import query. Runtime behavior is unchanged; these only
// keep the TypeScript view of the code honest.

declare module 'dagre' {
    const dagre: any;
    export default dagre;
}

declare module '*?worker&inline' {
    const workerConstructor: {
        new (): Worker;
    };
    export default workerConstructor;
}

declare module 'elkjs/lib/elk-api.js' {
    export interface ELKConstructorArguments {
        defaultLayoutOptions?: Record<string, string>;
        algorithms?: string[];
        workerUrl?: string;
        workerFactory?: (url?: string) => Worker;
    }
    export interface ELK {
        layout(graph: any, args?: any): Promise<any>;
        terminateWorker(): void;
    }
    const ElkConstructor: { new (args?: ELKConstructorArguments): ELK };
    export default ElkConstructor;
}
