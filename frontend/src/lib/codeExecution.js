import axiosInstance from "./axios";

const SUPPORTED_LANGUAGES = new Set(["javascript", "python", "java"]);

/**
 * @param {string} language - programming language
 * @param {string} code - source code to execute
 * @returns {Promise<{success:boolean, output?:string, error?: string}>}
 */
export async function executeCode(language, code) {
  try {
    if (!SUPPORTED_LANGUAGES.has(language)) {
      return {
        success: false,
        error: `Unsupported language: ${language}`,
      };
    }

    const response = await axiosInstance.post("/code/execute", {
      language,
      code,
    });
    const data = response?.data ?? {};

    return {
      success: Boolean(data.success),
      output: data.output || "No output",
      error: data.error,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to execute code: ${error.message}`,
    };
  }
}
