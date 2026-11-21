import { test } from 'node:test';
import { documentWorkflowCases } from '../tests/helpers/documentWorkflowCases.js';

// 无模型凭据时也能本地验证控制流；不能当真实模型质量评测。
documentWorkflowCases(test);
