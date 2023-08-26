#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from '../lib/application-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { RepositoryStack } from '../lib/repository-stack';

const app = new cdk.App();
const uatAccountId = app.node.tryGetContext('uat-account') || process.env.CDK_INTEG_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT;
const prodAccountId = app.node.tryGetContext('prod-account') || process.env.CDK_INTEG_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT;

new RepositoryStack(app, 'RepositoryStack');

const uatApplicationStack = new ApplicationStack(app, 'UatApplicationStack', { stageName: 'uat' });
const prodApplicationStack = new ApplicationStack(app, 'ProdApplicationStack', { stageName: 'prod' });
new PipelineStack(app, 'CrossAccountPipelineStack', {
  uatApplicationStack: uatApplicationStack,
  uatAccountId: uatAccountId,
  prodApplicationStack: prodApplicationStack,
  prodAccountId: prodAccountId,
});
