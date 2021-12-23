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


# Run this script in the tools account to clean up what was deployed
# Prerequisites: 
# - Set up .aws/credentials profiles for pipeline, uat, and prod
# - Set TOOLS_ACCOUNT_ID env variable
# - Deploy the solution using automate_deployment.sh

# If prerequisite account values aren't set, exit
if [[ -z "${TOOLS_ACCOUNT_ID}" ]]; then
  printf "Please set TOOLS_ACCOUNT_ID, UAT_ACCOUNT_ID, and PROD_ACCOUNT_ID"
  printf "TOOLS_ACCOUNT_ID =" ${TOOLS_ACCOUNT_ID}
  exit
fi

# Delete CloudFormation deployments in UAT and Prod accts
aws cloudformation delete-stack --stack-name UatApplicationDeploymentStack --profile uat &
aws cloudformation delete-stack --stack-name ProdApplicationDeploymentStack --profile prod &

# Empty artifact bucket in pipeline acct (prerequisite for destroying the pipeline stack and its S3 bucket)
aws s3 rm s3://artifact-bucket-${TOOLS_ACCOUNT_ID} --recursive --profile pipeline

# Destroy Cross-Account Pipeline
cdk destroy CrossAccountPipelineStack --profile pipeline

# Delete Cross-Account roles
aws cloudformation delete-stack --stack-name CodePipelineCrossAccountRole --profile uat &
aws cloudformation delete-stack --stack-name CodePipelineCrossAccountRole --profile prod &
aws cloudformation delete-stack --stack-name CloudFormationDeploymentRole --profile uat & 
aws cloudformation delete-stack --stack-name CloudFormationDeploymentRole --profile prod &

# Delete repository stack
cdk destroy RepositoryStack --profile pipeline 