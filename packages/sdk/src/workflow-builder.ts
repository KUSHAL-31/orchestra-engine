import type { SubmitWorkflowOptions } from './types';

type StepInput = SubmitWorkflowOptions['steps'][number];

export class WorkflowBuilder {
  private readonly _name: string;
  private readonly _steps: StepInput[] = [];
  private _onFailure?: SubmitWorkflowOptions['onFailure'];
  private readonly _submit: (options: SubmitWorkflowOptions) => Promise<{ workflowId: string }>;

  constructor(
    name: string,
    submit: (options: SubmitWorkflowOptions) => Promise<{ workflowId: string }>
  ) {
    this._name = name;
    this._submit = submit;
  }

  step(input: StepInput): this {
    this._steps.push(input);
    return this;
  }

  onFailure(job: NonNullable<SubmitWorkflowOptions['onFailure']>): this {
    this._onFailure = job;
    return this;
  }

  submit(): Promise<{ workflowId: string }> {
    return this._submit({
      name: this._name,
      steps: this._steps,
      onFailure: this._onFailure,
    });
  }
}
