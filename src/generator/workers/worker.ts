import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

export enum InputType {
  ENUM = 'enum',
  MODEL = 'model',
  OUTPUT = 'output',
  INPUT = 'input',
  RELATION_RESOLVER = 'relation-resolver',
  CRUD_RESOLVER = 'crud-resolver',
  ENHANCE = 'enhance',
  SCALAR = 'scalar',
  HELPER = 'helper'

}

export interface MorphWorkerOptions {
  inputType: string;
  workerPath: string;
}

export class MorphWorker {
  inputType: string;
  workerPath: string;

  worker: Worker;

  initialized = false
  running = false

  constructor(options: MorphWorkerOptions) {
    this.inputType = options.inputType;
    this.workerPath = options.workerPath;

    if (!existsSync(this.workerPath)) {
      throw new Error(`Worker path ${this.workerPath} does not exist`);
    }

    this.worker = new Worker(this.workerPath, {
      name: `${this.inputType}-worker`,
      resourceLimits: {
        stackSizeMb: 1024 * 1024 * 10,
      },
    });
  }

  static async create(options: MorphWorkerOptions) {
    const worker = new MorphWorker(options);
    await worker.init();
    return worker;
  }

  async init() {
    this.worker.on('message', (message) => {
      console.log(`Received message from worker: ${message}`);
    });
  }
}
