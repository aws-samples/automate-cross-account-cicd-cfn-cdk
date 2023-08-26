// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities } from 'aws-cdk-lib';

import { ApplicationStack } from '../lib/application-stack';

export interface PipelineStackProps extends StackProps {
  readonly uatApplicationStack: ApplicationStack;
  readonly uatAccountId: string;
  readonly prodApplicationStack: ApplicationStack;
  readonly prodAccountId: string;
}

export class PipelineStack extends Stack {

  constructor(app: App, id: string, props: PipelineStackProps) {

    super(app, id, props);

    const repository = codecommit.Repository.fromRepositoryName(this, 
      'CodeCommitRepo', 
      `repo-${this.account}`);

    // Resolve ARNs of cross-account roles for the UAT account
    const uatCloudFormationRole = iam.Role.fromRoleArn(this, 
      'UatDeploymentRole', 
      `arn:aws:iam::${props.uatAccountId}:role/CloudFormationDeploymentRole`, {
        mutable: false
    });
    const uatCodePipelineRole = iam.Role.fromRoleArn(this, 
      'UatCrossAccountRole', 
      `arn:aws:iam::${props.uatAccountId}:role/CodePipelineCrossAccountRole`, {
        mutable: false
    });

    // Resolve ARNS of cross-account roles for the Prod account
    const prodCloudFormationRole = iam.Role.fromRoleArn(this, 
      'ProdDeploymentRole', 
      `arn:aws:iam::${props.prodAccountId}:role/CloudFormationDeploymentRole`, {
        mutable: false
    });
    const prodCodeDeployRole = iam.Role.fromRoleArn(this, 
      'ProdCrossAccountRole', 
      `arn:aws:iam::${props.prodAccountId}:role/CodePipelineCrossAccountRole`, {
        mutable: false
    });

    // Resolve root Principal ARNs for both deployment accounts
    const uatAccountRootPrincipal = new iam.AccountPrincipal(props.uatAccountId);
    const prodAccountRootPrincipal = new iam.AccountPrincipal(props.prodAccountId);

    // Create KMS key and update policy with cross-account access
    const key = new kms.Key(this, 'ArtifactKey', {
      alias: 'key/pipeline-artifact-key',
    });
    key.grantDecrypt(uatAccountRootPrincipal);
    key.grantDecrypt(uatCodePipelineRole);
    key.grantDecrypt(prodAccountRootPrincipal);
    key.grantDecrypt(prodCodeDeployRole);

    // Create S3 bucket with target account cross-account access
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `artifact-bucket-${this.account}`,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key
    });
    artifactBucket.grantPut(uatAccountRootPrincipal);
    artifactBucket.grantRead(uatAccountRootPrincipal);
    artifactBucket.grantPut(prodAccountRootPrincipal);
    artifactBucket.grantRead(prodAccountRootPrincipal);

    // CDK build definition
    const cdkBuild = new codebuild.PipelineProject(this, 'CdkBuild', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'npm install'
            ],
          },
          build: {
            commands: [
              'npm run build',
              'npm run cdk synth -- -o dist',
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: [
            '*ApplicationStack.template.json',
          ],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
      // use the encryption key for build artifacts
      encryptionKey: key
    });

    // Lambda build definition
    const lambdaBuild = new codebuild.PipelineProject(this, 'LambdaBuild', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'cd app',
              'npm install',
            ],
          },
          build: {
            commands: 'npm run build',
          },
        },
        artifacts: {
          'base-directory': 'app',
          files: [
            'index.js',
            'node_modules/**/*',
          ],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
      },
      // use the encryption key for build artifacts
      encryptionKey: key
    });

    // Define pipeline stage output artifacts
    const sourceOutput = new codepipeline.Artifact();
    const cdkBuildOutput = new codepipeline.Artifact('CdkBuildOutput');
    const lambdaBuildOutput = new codepipeline.Artifact('LambdaBuildOutput');

    // Pipeline definition
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'CrossAccountPipeline',
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: 'CodeCommit_Source',
              repository: repository,
              output: sourceOutput,
              branch: 'main'
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Application_Build',
              project: lambdaBuild,
              input: sourceOutput,
              outputs: [lambdaBuildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CDK_Synth',
              project: cdkBuild,
              input: sourceOutput,
              outputs: [cdkBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy_Uat',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'Deploy',
              templatePath: cdkBuildOutput.atPath('UatApplicationStack.template.json'),
              stackName: 'UatApplicationDeploymentStack',
              adminPermissions: false,
              parameterOverrides: {
                ...props.uatApplicationStack.lambdaCode.assign(
                    lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: uatCodePipelineRole,
              deploymentRole: uatCloudFormationRole,
            })
          ],
        },
        {
          stageName: 'Deploy_Prod',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'Deploy',
              templatePath: cdkBuildOutput.atPath('ProdApplicationStack.template.json'),
              stackName: 'ProdApplicationDeploymentStack',
              adminPermissions: false,
              parameterOverrides: {
                ...props.prodApplicationStack.lambdaCode.assign(
                    lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: prodCodeDeployRole,
              deploymentRole: prodCloudFormationRole,
            }),
          ],
        },
      ],
    });

    // Add the target accounts to the pipeline policy
    pipeline.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        `arn:aws:iam::${props.uatAccountId}:role/*`,
        `arn:aws:iam::${props.prodAccountId}:role/*`
      ]
    }));

    // Publish the KMS Key ARN as an output
    new CfnOutput(this, 'ArtifactBucketEncryptionKeyArn', {
      value: key.keyArn,
      exportName: 'ArtifactBucketEncryptionKey'
    });

  }
}
