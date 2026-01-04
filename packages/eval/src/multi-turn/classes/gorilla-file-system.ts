export class File {
  name: string;
  content: string;

  constructor(name: string, content = "") {
    this.name = name;
    this.content = content;
  }

  _write(newContent: string): void {
    this.content = newContent;
  }

  _read(): string {
    return this.content;
  }
}

export class Directory {
  name: string;
  parent: Directory | null;
  contents: Record<string, File | Directory>;

  constructor(name: string, parent: Directory | null = null) {
    this.name = name;
    this.parent = parent;
    this.contents = {};
  }

  _addFile(fileName: string, content = ""): void {
    this.contents[fileName] = new File(fileName, content);
  }

  _addDirectory(dirName: string): void {
    this.contents[dirName] = new Directory(dirName, this);
  }

  _getItem(itemName: string): File | Directory | null {
    if (itemName === ".") return this;
    return this.contents[itemName] || null;
  }

  _listContents(): string[] {
    return Object.keys(this.contents);
  }
}

export class GorillaFileSystem {
  private root!: Directory;
  private _currentDir!: Directory;
  private longContext = false;

  constructor() {
    this.root = new Directory("/", null);
    this._currentDir = this.root;
  }

  _loadScenario(scenario: any, longContext = false): void {
    this.longContext = longContext;
    this.root = new Directory("/", null);

    if (scenario && scenario.root) {
      const rootKeys = Object.keys(scenario.root);
      if (rootKeys.length > 0) {
        const rootDirName = rootKeys[0];
        const rootDir = new Directory(rootDirName, null);
        this.root = this._loadDirectory(
          scenario.root[rootDirName].contents || {},
          rootDir
        );
      }
    }
    this._currentDir = this.root;
  }

  private _loadDirectory(current: any, parent: Directory): Directory {
    for (const [name, data] of Object.entries(current as Record<string, any>)) {
      if (data.type === "directory") {
        const newDir = new Directory(name, parent);
        const loadedDir = this._loadDirectory(data.contents || {}, newDir);
        parent.contents[name] = loadedDir;
      } else if (data.type === "file") {
        parent.contents[name] = new File(name, data.content || "");
      }
    }
    return parent;
  }

  pwd(): Record<string, string> {
    const path: string[] = [];
    let dir: Directory | null = this._currentDir;
    while (dir !== null) {
      path.push(dir.name);
      dir = dir.parent;
    }
    return { current_working_directory: "/" + path.reverse().join("/") };
  }

  ls(a = false): Record<string, string[]> {
    let contents = this._currentDir._listContents();
    if (!a) {
      contents = contents.filter((item) => !item.startsWith("."));
    }
    return { current_directory_content: contents };
  }

  cd(folder: string): Record<string, string> | null {
    folder = folder.replace(/\/+$/, "");
    if (folder === "") folder = "/";

    if (
      folder !== "." &&
      folder !== ".." &&
      folder !== "/" &&
      folder.includes("/")
    ) {
      return {
        error: `cd: ${folder}: Unsupported path. Only one folder level at a time is supported.`,
      };
    }

    if (folder === "..") {
      if (this._currentDir.parent) {
        this._currentDir = this._currentDir.parent;
        return {};
      }
      if (this.root === this._currentDir) {
        return {
          error: "Current directory is already the root. Cannot go back.",
        };
      }
      return { error: "cd: ..: No such directory" };
    }

    const targetDir = this._navigateToDirectory(folder);
    if (targetDir && "error" in targetDir) {
      return targetDir as Record<string, string>;
    }
    if (targetDir instanceof Directory) {
      this._currentDir = targetDir;
      return { current_working_directory: targetDir.name };
    }
    return { error: `cd: ${folder}: No such file or directory` };
  }

  mkdir(dir_name: string): Record<string, string> | null {
    if (dir_name in this._currentDir.contents) {
      return {
        error: `mkdir: cannot create directory '${dir_name}': File exists`,
      };
    }
    this._currentDir._addDirectory(dir_name);
    return null;
  }

  touch(file_name: string): Record<string, string> | null {
    if (file_name in this._currentDir.contents) {
      return { error: `touch: cannot touch '${file_name}': File exists` };
    }
    this._currentDir._addFile(file_name);
    return null;
  }

  echo(content: string, file_name?: string): Record<string, string> | null {
    if (file_name === undefined || file_name === null) {
      return { terminal_output: content };
    }
    if (file_name in this._currentDir.contents) {
      const item = this._currentDir._getItem(file_name);
      if (item instanceof File) {
        item._write(content);
        return null;
      }
    }
    return { error: `echo: cannot write to '${file_name}': No such file` };
  }

  cat(file_name: string): Record<string, string> {
    if (file_name in this._currentDir.contents) {
      const item = this._currentDir._getItem(file_name);
      if (item instanceof File) {
        return { file_content: item._read() };
      }
      return { error: `cat: '${file_name}': Is a directory` };
    }
    return { error: `cat: '${file_name}': No such file or directory` };
  }

  find(
    path = ".",
    name?: string
  ): Record<string, string[]> | Record<string, string> {
    const targetDir = this._navigateToDirectory(path);
    if (targetDir && "error" in targetDir) {
      const errMsg = (targetDir as Record<string, string>).error || "";
      if (errMsg.startsWith("cd:")) {
        return { error: errMsg.replace("cd:", "find:") };
      }
      return targetDir as Record<string, string>;
    }

    const matches: string[] = [];
    const recursiveSearch = (directory: Directory, basePath: string): void => {
      for (const [itemName, item] of Object.entries(directory.contents)) {
        const itemPath = `${basePath}/${itemName}`;
        if (name === undefined || name === null || itemName.includes(name)) {
          matches.push(itemPath);
        }
        if (item instanceof Directory) {
          recursiveSearch(item, itemPath);
        }
      }
    };

    if (targetDir instanceof Directory) {
      recursiveSearch(targetDir, path.replace(/\/+$/, ""));
    }
    return { matches };
  }

  wc(file_name: string, mode = "l"): Record<string, number | string> {
    if (!["l", "w", "c"].includes(mode)) {
      return { error: `wc: invalid mode '${mode}'` };
    }

    if (file_name in this._currentDir.contents) {
      const file = this._currentDir._getItem(file_name);
      if (file instanceof File) {
        const content = file._read();
        if (mode === "l") {
          return { count: content.split("\n").length, type: "lines" };
        }
        if (mode === "w") {
          return {
            count: content.split(/\s+/).filter(Boolean).length,
            type: "words",
          };
        }
        if (mode === "c") {
          return { count: content.length, type: "characters" };
        }
      }
    }
    return { error: `wc: ${file_name}: No such file or directory` };
  }

  sort(file_name: string): Record<string, string> {
    if (file_name in this._currentDir.contents) {
      const file = this._currentDir._getItem(file_name);
      if (file instanceof File) {
        const content = file._read();
        const sortedContent = content.split("\n").sort().join("\n");
        return { sorted_content: sortedContent };
      }
    }
    return { error: `sort: ${file_name}: No such file or directory` };
  }

  grep(file_name: string, pattern: string): Record<string, string[] | string> {
    if (file_name in this._currentDir.contents) {
      const file = this._currentDir._getItem(file_name);
      if (file instanceof File) {
        const content = file._read();
        const matchingLines = content
          .split("\n")
          .filter((line) => line.includes(pattern));
        return { matching_lines: matchingLines };
      }
    }
    return { error: `grep: ${file_name}: No such file or directory` };
  }

  du(human_readable = false): Record<string, string> {
    const getSize = (item: File | Directory): number => {
      if (item instanceof File) {
        return new TextEncoder().encode(item._read()).length;
      }
      if (item instanceof Directory) {
        return Object.values(item.contents).reduce(
          (acc, child) => acc + getSize(child),
          0
        );
      }
      return 0;
    };

    const totalSize = getSize(this._currentDir);

    if (human_readable) {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let unitIndex = 0;
      let size = totalSize;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      return { disk_usage: `${size.toFixed(2)} ${units[unitIndex]}` };
    }
    return { disk_usage: `${totalSize} bytes` };
  }

  tail(file_name: string, lines = 10): Record<string, string> {
    if (file_name in this._currentDir.contents) {
      const file = this._currentDir._getItem(file_name);
      if (file instanceof File) {
        const content = file._read().split("\n");
        const actualLines = Math.min(lines, content.length);
        const lastLines = content.slice(-actualLines);
        return { last_lines: lastLines.join("\n") };
      }
    }
    return { error: `tail: ${file_name}: No such file or directory` };
  }

  diff(file_name1: string, file_name2: string): Record<string, string> {
    if (
      file_name1 in this._currentDir.contents &&
      file_name2 in this._currentDir.contents
    ) {
      const file1 = this._currentDir._getItem(file_name1);
      const file2 = this._currentDir._getItem(file_name2);
      if (file1 instanceof File && file2 instanceof File) {
        const content1 = file1._read().split("\n");
        const content2 = file2._read().split("\n");
        const diffLines: string[] = [];
        const maxLen = Math.max(content1.length, content2.length);
        for (let i = 0; i < maxLen; i++) {
          const line1 = content1[i] || "";
          const line2 = content2[i] || "";
          if (line1 !== line2) {
            diffLines.push(`- ${line1}\n+ ${line2}`);
          }
        }
        return { diff_lines: diffLines.join("\n") };
      }
    }
    return {
      error: `diff: ${file_name1} or ${file_name2}: No such file or directory`,
    };
  }

  mv(source: string, destination: string): Record<string, string> {
    if (!(source in this._currentDir.contents)) {
      return {
        error: `mv: cannot move '${source}': No such file or directory`,
      };
    }

    const item = this._currentDir._getItem(source);
    if (!(item instanceof File || item instanceof Directory)) {
      return { error: `mv: cannot move '${source}': Not a file or directory` };
    }

    if (destination.includes("/")) {
      return {
        error:
          "mv: path not allowed in destination. Provide only a file or directory name.",
      };
    }

    if (destination in this._currentDir.contents) {
      const destItem = this._currentDir._getItem(destination);
      if (destItem instanceof Directory) {
        if (source in destItem.contents) {
          return {
            error: `mv: cannot move '${source}' to '${destination}/${source}': File exists`,
          };
        }
        delete this._currentDir.contents[source];
        if (item instanceof File) {
          destItem._addFile(source, item.content);
        } else {
          destItem._addDirectory(source);
          (destItem.contents[source] as Directory).contents = item.contents;
        }
        return { result: `'${source}' moved to '${destination}/${source}'` };
      }
      return {
        error: `mv: cannot move '${source}' to '${destination}': Not a directory`,
      };
    }

    delete this._currentDir.contents[source];
    if (item instanceof File) {
      this._currentDir._addFile(destination, item.content);
    } else {
      this._currentDir._addDirectory(destination);
      (this._currentDir.contents[destination] as Directory).contents =
        item.contents;
    }
    return { result: `'${source}' moved to '${destination}'` };
  }

  rm(file_name: string): Record<string, string> {
    if (file_name in this._currentDir.contents) {
      delete this._currentDir.contents[file_name];
      return { result: `'${file_name}' removed` };
    }
    return {
      error: `rm: cannot remove '${file_name}': No such file or directory`,
    };
  }

  rmdir(dir_name: string): Record<string, string> {
    if (dir_name in this._currentDir.contents) {
      const item = this._currentDir._getItem(dir_name);
      if (item instanceof Directory) {
        if (Object.keys(item.contents).length > 0) {
          return {
            error: `rmdir: cannot remove '${dir_name}': Directory not empty`,
          };
        }
        delete this._currentDir.contents[dir_name];
        return { result: `'${dir_name}' removed` };
      }
      return { error: `rmdir: cannot remove '${dir_name}': Not a directory` };
    }
    return {
      error: `rmdir: cannot remove '${dir_name}': No such file or directory`,
    };
  }

  cp(source: string, destination: string): Record<string, string> {
    if (!(source in this._currentDir.contents)) {
      return {
        error: `cp: cannot copy '${source}': No such file or directory`,
      };
    }

    const item = this._currentDir._getItem(source);
    if (!(item instanceof File || item instanceof Directory)) {
      return { error: `cp: cannot copy '${source}': Not a file or directory` };
    }

    if (destination.includes("/")) {
      return {
        error:
          "cp: path not allowed in destination. Provide only a file or directory name.",
      };
    }

    if (destination in this._currentDir.contents) {
      const destItem = this._currentDir._getItem(destination);
      if (destItem instanceof Directory) {
        if (source in destItem.contents) {
          return {
            error: `cp: cannot copy '${source}' to '${destination}/${source}': File exists`,
          };
        }
        if (item instanceof File) {
          destItem._addFile(source, item.content);
        } else {
          destItem._addDirectory(source);
          (destItem.contents[source] as Directory).contents = {
            ...item.contents,
          };
        }
        return { result: `'${source}' copied to '${destination}/${source}'` };
      }
      return {
        error: `cp: cannot copy '${source}' to '${destination}': Not a directory`,
      };
    }

    if (item instanceof File) {
      this._currentDir._addFile(destination, item.content);
    } else {
      this._currentDir._addDirectory(destination);
      (this._currentDir.contents[destination] as Directory).contents = {
        ...item.contents,
      };
    }
    return { result: `'${source}' copied to '${destination}'` };
  }

  private _navigateToDirectory(
    path: string | null
  ): Directory | Record<string, string> {
    if (path === null || path === ".") {
      return this._currentDir;
    }
    if (path === "/") {
      return this.root;
    }

    const dirs = path.replace(/^\/+|\/+$/g, "").split("/");
    let tempDir: Directory = path.startsWith("/")
      ? this.root
      : this._currentDir;

    for (const dirName of dirs) {
      const nextDir = tempDir._getItem(dirName);
      if (nextDir instanceof Directory) {
        tempDir = nextDir;
      } else {
        return { error: `cd: '${path}': No such file or directory` };
      }
    }
    return tempDir;
  }

  equals(other: any): boolean {
    if (!(other instanceof GorillaFileSystem)) return false;
    return JSON.stringify(this.root) === JSON.stringify(other.root);
  }
}
