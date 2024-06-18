import { Octokit } from "@octokit/rest";
import prompt from "./query.json" assert { type: "json" };

const githubToken = process.env.GITHUB_TOKEN;
const apiKey = process.env.API_KEY;
const apiBase = process.env.API_BASE;
const prId = process.env.PR_ID;
const branchRef = "heads/auto-generated-integration-test";
const targetRepoOwner = "Azure";
const targetRepo = "azure-webpubsub";
const mainRef = "heads/main";
const octokit = new Octokit({
    auth: githubToken,
});

function parseResponseToJson(response) {
    let trimmed = response.trim();
    if (trimmed.startsWith("```json\n") && trimmed.endsWith("```")) {
        trimmed = trimmed.substring(7, trimmed.length - 3);
    }
    trimmed = trimmed.trim();
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        console.error("Failed to parse the deep prompt response to JSON:", error);
        return null;
    }
}

async function getLatestCommitSha(owner, repo) {
    try {
        const { data } = await octokit.rest.git.getRef({
            owner,
            repo,
            ref: mainRef,
        });
        return data.object.sha;
    } catch (error) {
        console.error("Failed to get latest commit SHA:", error.message);
        throw error;
    }
}

async function createChangeBranch(owner, repo, sha) {
    try {
        const { data } = await octokit.rest.git.getRef({
            owner,
            repo,
            ref: `refs/${branchRef}`,
        });
        console.log("Branch already exists, using existing branch SHA:", data.object.sha);
        return data.object.sha;
    } catch (error) {
        if (error.status === 404) {
            try {
                const { data: newData } = await octokit.rest.git.createRef({
                    owner,
                    repo,
                    ref: `refs/${branchRef}`,
                    sha,
                });
                console.log("Branch auto-generated-integration-test created successfully, new branch SHA:", newData.object.sha);
                return newData.object.sha;
            } catch (error) {
                console.error("Failed to create branch:", error.message);
                throw error;
            }
        } else {
            console.error("Failed to check branch existence:", error.message);
            throw error;
        }
    }
}


async function createBlob(owner, repo, files) {
    try {
        return await Promise.all(files.map(async file => {
            const { data } = await octokit.rest.git.createBlob({
                owner,
                repo,
                content: file.fileContent,
                encoding: "utf-8",
            });
            return {
                sha: data.sha,
                path: file.fileName,
                mode: "100644",
                type: "blob",
            };
        }));
    } catch (error) {
        console.error("Failed to create blobs:", error.message);
        throw error;
    }
}

async function createTree(owner, repo, blobs, branchSha) {
    try {
        const { data } = await octokit.rest.git.createTree({
            owner,
            repo,
            base_tree: branchSha,
            tree: blobs,
        });
        return data.sha;
    } catch (error) {
        console.error("Failed to create tree:", error.message);
        throw error;
    }
}

async function createCommit(owner, repo, treeSha, branchSha) {
    try {
        const { data } = await octokit.rest.git.createCommit({
            owner,
            repo,
            message: "[auto-generated]sync translation pull request",
            tree: treeSha,
            parents: [branchSha],
        });
        return data.sha;
    } catch (error) {
        console.error("Failed to create commit:", error.message);
        throw error;
    }
}

async function updateBranch(owner, repo, commitSha) {
    try {
        await octokit.rest.git.updateRef({
            owner,
            repo,
            ref: branchRef,
            sha: commitSha,
        });
    } catch (error) {
        console.error("Failed to push the commit on branch,", error.message);
        throw error;
    }
}

async function createPR(owner, repo) {
    try {
        const { data } = await octokit.rest.pulls.create({
            owner,
            repo,
            title: "auto-generated-Sync test",
            head: "auto-generated-integration-test",
            base: "main",
            body: "Please pull these awesome changes in!",
            draft: false,
        });
        console.log("PR created: ", data.html_url);
    } catch (error) {
        console.error("Failed to create pull request, ", error.message);
        throw error;
    }
}

async function getSessionAccess() {
    try {
        return fetch("https://data-ai.microsoft.com/deepprompt/api/v1/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: githubToken,
                provider: "github",
            }),
        }).then(res => res.json());
    } catch (error) {
        console.error("Failed to exchange github token");
        throw error;
    }
}

function getChangedFileLanguage(changedFiles) {
    for (const file of changedFiles) {
        if (file.fileName.includes(".java")) {
            return "java";
        } else if (file.fileName.includes(".py")) {
            return "python";
        } else if (file.fileName.includes(".js")) {
            return "javascript";
        } else if (file.fileName.includes(".go")) {
            return "go";
        } else if (file.fileName.includes(".cs")) {
            return "csharp";
        }
    }
    return ""
}

async function syncPrChange() {
    const languages = ["javascript", "python", "csharp", "go", "java"];
    const accessSession = await getSessionAccess();
    const changedFiles = await getChangedFiles("Azure", "azure-webpubsub", prId);
    const changedFileLanguage = getChangedFileLanguage(changedFiles);
    let translatedFiles = [];
    for (const language of languages) {
        if (language !== changedFileLanguage) {
            for (const file of changedFiles) {
                if (file.filename.includes(".cs") || file.filename.includes(".py") || file.filename.includes(".js") || file.filename.includes(".go") || file.filename.includes(".java")) {
                    console.log(`start translating ${file.filename} ...`);
                    const dpResponse = await translate(file, accessSession.session_id, accessSession.access_token, language);
                    translatedFiles.push(dpResponse);
                    console.log(`[${changedFileLanguage} => ${language}]${file.filename} translation complete`);
                }
            }
        }
    }


    //prepare for github commit
    const sha = await getLatestCommitSha(targetRepoOwner, targetRepo);
    const changeSha = await createChangeBranch(targetRepoOwner, targetRepo, sha);

    //stash files -> commit -> push
    const blobs = await createBlob(targetRepoOwner, targetRepo, translatedFiles);
    const treeSha = await createTree(targetRepoOwner, targetRepo, blobs, changeSha);
    const commitSha = await createCommit(targetRepoOwner, targetRepo, treeSha, changeSha);
    await updateBranch(targetRepoOwner, targetRepo, commitSha);

    //create pr
//    await createPR(targetRepoOwner, targetRepo);
}

async function translate(file, sessionId, accessToken, targetLanguage) {
    const query = `
                Below is a file change patch from github pull request.
                Go through this file name and file patch then translate the file content to ${targetLanguage}.
                Return the response in stringfied json format, with fileName and fileContent.
                The file name should begin with path tests/integration-tests/${targetLanguage}
                For your response, use same environment variable(hub, connection string, messages etc.) as the original file.
                Do not omit any file content. The response should contain as many tests as the original document.

                Include these import statement as necessary in your response:
                ###
                ${prompt[targetLanguage]}
                ###`;
    try {
        while (true) {
            const dpResponse = await fetch("https://data-ai.microsoft.com/deepprompt/api/v1/query", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "DeepPrompt-Session-ID": sessionId,
                    "Authorization": `Bearer ${accessToken}`,
                    "DeepPrompt-OpenAI-API-Base": apiBase,
                    "DeepPrompt-OpenAI-API-Key": apiKey,
                    "DeepPrompt-OpenAI-Deployment": "gpt-4o",
                },
                body: JSON.stringify({
                    query: `${query}\n File Name: ###${file.filename}\n ###File patch:\n ###${file.patch}###`,
                }),
            }).then(res => res.json());
            console.log(dpResponse.response_text);
            if (dpResponse.response_text.includes("fileName") && dpResponse.response_text.includes("fileContent")) {
                return parseResponseToJson(dpResponse.response_text);
            }
        }
    } catch (error) {
        console.error("Failed to fetch deep prompt rest api, ", error.message);
        throw error;
    }
}

async function getChangedFiles(owner, repo, prId) {
    try {
        const { data: files } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prId,
        });
        return files;
    } catch (error) {
        console.error(`Faield to load pull request ${prId}: `, error.message);
        throw error;
    }
}

syncPrChange();