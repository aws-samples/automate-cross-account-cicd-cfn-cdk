#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this
# software and associated documentation files (the "Software"), to deal in the Software
# without restriction, including without limitation the rights to use, copy, modify,
# merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
# PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
# HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
# SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Prerequisites: 
# - Set up .aws/credentials profiles for pipeline, uat, and prod
# - Set TOOLS_ACCOUNT_ID, UAT_ACCOUNT_ID, and PROD_ACCOUNT_ID env variables
# - Clone repo with CloudFormation templates and CDK code locally
# - Initialize and bootstrap CDK in the Tools account
# - Install and configure git

# If prerequisite account values aren't set, exit
if [[ -z "${TOOLS_ACCOUNT_ID}" || -z "${UAT_ACCOUNT_ID}" || -z "${PROD_ACCOUNT_ID}" ]]; then
  printf "Please set TOOLS_ACCOUNT_ID, UAT_ACCOUNT_ID, and PROD_ACCOUNT_ID"
  printf "TOOLS_ACCOUNT_ID =" ${TOOLS_ACCOUNT_ID}
  printf "UAT_ACCOUNT_ID =" ${UAT_ACCOUNT_ID}
  printf "PROD_ACCOUNT_ID =" ${PROD_ACCOUNT_ID}
  exit
fi

# Deploy roles without policies so the ARNs exist when the CDK Stack is deployed in parallel
printf "\nDeploying roles to UAT and Prod\n"
aws cloudformation deploy --template-file templates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile uat \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Uat &

aws cloudformation deploy --template-file templates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile uat \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Uat &

aws cloudformation deploy --template-file templates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Prod &
    
aws cloudformation deploy --template-file templates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Prod 


# Deploy Repository CDK Stack 
printf "\nDeploying Repository Stack\n"
npm install
npm audit fix
npm run build
cdk synth
cdk deploy RepositoryStack —profile pipeline

# Deploy Pipeline CDK stack, write output to a file to gather key arn
printf "\nDeploying Cross-Account Deployment Pipeline Stack\n"

CDK_OUTPUT_FILE='.cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .cfn_outputs
npx cdk deploy CrossAccountPipelineStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context uat-account=${UAT_ACCOUNT_ID} \
  —profile pipeline \
  --require-approval never \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .cfn_outputs
KEY_ARN=$(awk -F " " '/KeyArn/ { print $3 }' .cfn_outputs)

# Check that KEY_ARN is set after the CDK deployment
if [[ -z "${KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the CDK Pipeline deployment"
  exit
fi

# Update the CloudFormation roles with the Key ARNy in parallel
printf "\nUpdating roles with policies in UAT and Prod\n"
aws cloudformation deploy --template-file templates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile uat \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Uat KeyArn=${KEY_ARN} &

aws cloudformation deploy --template-file templates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile uat \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Uat KeyArn=${KEY_ARN} &

aws cloudformation deploy --template-file templates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} &

aws cloudformation deploy --template-file templates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides ToolsAccountID=${TOOLS_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} 

# Commit initial code to new repo (which will trigger a fresh pipeline execution)
printf "\nCommitting code to repository\n"
git init && git branch -m main && git add . && git commit -m "Initial commit" && git remote rm origin
git remote add origin https://git-codecommit.us-west-2.amazonaws.com/v1/repos/repo-${TOOLS_ACCOUNT_ID}
git config main.remove origin && git config main.merge refs/heads/main && git push --set-upstream origin main

# Get deployed API Gateway endpoints
printf "\nUse the following commands to get the Endpoints for deployed environemnts: "
printf "\n  aws cloudformation describe-stacks --stack-name UatApplicationDeploymentStack \
  --profile uat | grep OutputValue"
printf "\n  aws cloudformation describe-stacks --stack-name ProdApplicationDeploymentStack \
  --profile prod | grep OutputValue"

# Clean up temporary files
rm ${CDK_OUTPUT_FILE} .cfn_outputs
