import os
import re

# Function to parse the Inherits line in the Markdown content
def parse_inherits(md_content):
    inherits_match = re.search(r'\*\*Inherits:\*\*\s*([\s\S]*?)\n', md_content)
    if inherits_match:
        inheritances = inherits_match.group(1).strip()
        return inheritances
    return None

# Function to replace paths inside brackets with empty brackets
def replace_paths_with_empty_brackets(line):
    def replace_path(match):
        default_path = 'docs/docs/src'
        path = default_path + match.group(0)[1:-1]  # Remove parentheses
        start = "docs/docs/src/src/X/X/"
        relative_path = os.path.relpath(path, start)
        print(f"Original Path: {relative_path}")
        return '(' + relative_path + ')'
    return re.sub(r'\([^)]+\)', replace_path, line)

# Function to process a single Markdown file
def process_md_file(file_path):
    with open(file_path, 'r') as file:
        md_content = file.read()

    # Parse Inherits line
    inherits = parse_inherits(md_content)

    # Modify the Inherits line
    if inherits:
        modified_inherits = replace_paths_with_empty_brackets(inherits)
        md_content = md_content.replace(inherits, modified_inherits)

    # Write the modified content back to the original file
    with open(file_path, 'w') as file:
        file.write(md_content)

    print(f"File modified: {file_path}")

    # Check if the file name is README.md or SUMMARY.md and delete it
    file_name = os.path.basename(file_path)
    if file_name.lower() in ['readme.md', 'summary.md']:
        os.remove(file_path)
        print(f"Deleted file: {file_path}")

# Main function to process all Markdown files in a directory and its subdirectories
def process_all_md_files(directory):
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith('.md'):
                file_path = os.path.join(root, file)
                process_md_file(file_path)

if __name__ == "__main__":
    # Specify the directory path
    directory_path = '../docs/docs/contracts/src'

    # Process all Markdown files in the specified directory and its subdirectories
    process_all_md_files(directory_path)

    print("All Markdown files in the directory processed.")
