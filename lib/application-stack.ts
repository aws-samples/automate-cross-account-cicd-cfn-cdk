// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StackProps, App, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';

export interface ApplicationStackProps extends StackProps {
  readonly stageName: string;
}

export class ApplicationStack extends Stack {
  public readonly lambdaCode: lambda.CfnParametersCode;

  constructor(app: App, id: string, props: ApplicationStackProps) {
    super(app, id, props);

    this.lambdaCode = lambda.Code.fromCfnParameters();

    const func = new lambda.Function(this, 'Lambda', {
      functionName: 'HelloLambda',
      code: this.lambdaCode,
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_LATEST,
      environment: {
        STAGE_NAME: props.stageName
      }
    });

    new apigateway.LambdaRestApi(this, 'HelloLambdaRestApi', {
      handler: func,
      endpointExportName: 'HelloLambdaRestApiEmdpoint',
      deployOptions: {
        stageName: props.stageName
      }
    });

    const version = func.currentVersion;
    const alias = new lambda.Alias(this, 'LambdaAlias', {
      aliasName: props.stageName,
      version,
    });

    new codedeploy.LambdaDeploymentGroup(this, 'DeploymentGroup', {
      alias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE,
    });

  }
}