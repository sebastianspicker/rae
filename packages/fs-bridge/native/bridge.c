/* Descriptor-relative filesystem mechanisms; transaction policy belongs to TypeScript. */
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value fail(napi_env env, const char *operation) {
  int saved = errno;
  const char *code = "EIO";
  switch (saved) {
    case EEXIST: code = "EEXIST"; break;
    case ENOENT: code = "ENOENT"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case ELOOP: code = "ELOOP"; break;
    case ENOTEMPTY: code = "ENOTEMPTY"; break;
    case EXDEV: code = "EXDEV"; break;
    case EACCES: code = "EACCES"; break;
    case EPERM: code = "EPERM"; break;
    case EBADF: code = "EBADF"; break;
    case EINVAL: code = "EINVAL"; break;
    case EILSEQ: code = "EILSEQ"; break;
    case ENOSYS: code = "ENOSYS"; break;
  }
  char message[256];
  snprintf(message, sizeof message, "%s: %s", operation, strerror(saved));
  napi_throw_error(env, code, message);
  return NULL;
}

static int arguments(napi_env env, napi_callback_info info, size_t count, napi_value *argv) {
  size_t actual = count;
  if (napi_get_cb_info(env, info, &actual, argv, NULL, NULL) != napi_ok || actual != count) {
    napi_throw_type_error(env, "EINVAL", "incorrect argument count");
    return 0;
  }
  return 1;
}

static int descriptor(napi_env env, napi_value value, int *fd) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 0 || number > INT32_MAX || number != (int)number) {
    napi_throw_type_error(env, "EINVAL", "invalid descriptor");
    return 0;
  }
  *fd = (int)number;
  return 1;
}

static char *path_value(napi_env env, napi_value value, int component) {
  bool buffer = false;
  size_t length = 0;
  char *result = NULL;
  void *bytes = NULL;
  napi_is_buffer(env, value, &buffer);
  if (buffer) {
    if (napi_get_buffer_info(env, value, &bytes, &length) != napi_ok) return NULL;
  } else if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "path must be a string or Buffer");
    return NULL;
  }
  if (length == 0 || length > 1048576) {
    napi_throw_type_error(env, "EINVAL", "invalid path length");
    return NULL;
  }
  result = malloc(length + 1);
  if (!result) { errno = ENOMEM; fail(env, "allocate path"); return NULL; }
  if (buffer) memcpy(result, bytes, length);
  else if (napi_get_value_string_utf8(env, value, result, length + 1, &length) != napi_ok) { free(result); return NULL; }
  result[length] = '\0';
  if (memchr(result, '\0', length) || (component && (strchr(result, '/') || !strcmp(result, ".") || !strcmp(result, "..")))) {
    free(result);
    napi_throw_type_error(env, "EINVAL", "invalid path component");
    return NULL;
  }
  return result;
}

static napi_value number_result(napi_env env, int result, const char *operation) {
  if (result < 0) return fail(env, operation);
  napi_value value;
  napi_create_int32(env, result, &value);
  return value;
}

static napi_value open_root(napi_env env, napi_callback_info info) {
  napi_value args[1];
  if (!arguments(env, info, 1, args)) return NULL;
  char *path = path_value(env, args[0], 0);
  if (!path) return NULL;
  if (path[0] != '/') { free(path); errno = EINVAL; return fail(env, "absolute root required"); }
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { free(path); return fail(env, "open root"); }
  char *part = path + 1;
  while (*part) {
    char *slash = strchr(part, '/');
    if (slash) *slash = '\0';
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) { close(fd); free(path); errno = EINVAL; return fail(env, "canonical root required"); }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    close(fd);
    if (next < 0) { free(path); errno = saved; return fail(env, "open root component"); }
    fd = next;
    if (!slash) break;
    part = slash + 1;
  }
  free(path);
  return number_result(env, fd, "open root");
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  napi_value args[3]; int parent; bool create;
  if (!arguments(env, info, 3, args) || !descriptor(env, args[0], &parent)) return NULL;
  if (napi_get_value_bool(env, args[2], &create) != napi_ok) { napi_throw_type_error(env, "EINVAL", "create must be boolean"); return NULL; }
  char *name = path_value(env, args[1], 1);
  if (!name) return NULL;
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 && errno == ENOENT && create) {
    if (mkdirat(parent, name, 0700) == 0 || errno == EEXIST)
      fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  }
  int saved = errno; free(name); errno = saved;
  return number_result(env, fd, "open directory");
}

static napi_value open_file(napi_env env, napi_callback_info info) {
  napi_value args[3]; int parent, mode;
  if (!arguments(env, info, 3, args) || !descriptor(env, args[0], &parent) || !descriptor(env, args[2], &mode)) return NULL;
  if (mode > 3) { errno = EINVAL; return fail(env, "invalid file mode"); }
  char *name = path_value(env, args[1], 1);
  if (!name) return NULL;
  int flags = O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
  flags |= (mode == 0 || mode == 3) ? O_RDONLY : (mode == 1 ? O_WRONLY | O_CREAT | O_EXCL : O_WRONLY | O_APPEND);
  int fd = openat(parent, name, flags, 0600);
  int saved = errno; free(name); errno = saved;
  if (fd < 0) return fail(env, "open file");
  struct stat metadata;
  if (fstat(fd, &metadata) < 0) { saved = errno; close(fd); errno = saved; return fail(env, "stat file"); }
  if (!S_ISREG(metadata.st_mode) || (mode != 3 && metadata.st_nlink != 1)) { close(fd); errno = EINVAL; return fail(env, "regular single-link file required"); }
  return number_result(env, fd, "open file");
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value args[3]; int parent, mode;
  if (!arguments(env, info, 3, args) || !descriptor(env, args[0], &parent) || !descriptor(env, args[2], &mode)) return NULL;
  if (mode > 0777) { errno = EINVAL; return fail(env, "invalid directory mode"); }
  char *name = path_value(env, args[1], 1);
  if (!name) return NULL;
  int result = mkdirat(parent, name, (mode_t)mode);
  int saved = errno; free(name); errno = saved;
  return number_result(env, result, "mkdir");
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value args[5]; int source, destination; bool exclusive;
  if (!arguments(env, info, 5, args) || !descriptor(env, args[0], &source) || !descriptor(env, args[2], &destination)) return NULL;
  if (napi_get_value_bool(env, args[4], &exclusive) != napi_ok) { napi_throw_type_error(env, "EINVAL", "noReplace must be boolean"); return NULL; }
  char *from = path_value(env, args[1], 1);
  if (!from) return NULL;
  char *to = path_value(env, args[3], 1);
  if (!to) { free(from); return NULL; }
  int result;
  if (!exclusive) result = renameat(source, from, destination, to);
  else {
#if defined(__APPLE__)
    result = renameatx_np(source, from, destination, to, RENAME_EXCL);
#elif defined(__linux__)
    result = renameat2(source, from, destination, to, RENAME_NOREPLACE);
#else
    errno = ENOSYS; result = -1;
#endif
  }
  int saved = errno; free(from); free(to); errno = saved;
  return number_result(env, result, "rename");
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value args[3]; int parent; bool directory;
  if (!arguments(env, info, 3, args) || !descriptor(env, args[0], &parent)) return NULL;
  if (napi_get_value_bool(env, args[2], &directory) != napi_ok) { napi_throw_type_error(env, "EINVAL", "directory must be boolean"); return NULL; }
  char *name = path_value(env, args[1], 1);
  if (!name) return NULL;
  int result = unlinkat(parent, name, directory ? AT_REMOVEDIR : 0);
  int saved = errno; free(name); errno = saved;
  return number_result(env, result, "unlink");
}

static napi_value read_directory(napi_env env, napi_callback_info info) {
  napi_value args[1], result; int fd;
  if (!arguments(env, info, 1, args) || !descriptor(env, args[0], &fd)) return NULL;
  /* A new open file description avoids sharing offsets with another enumeration. */
  int copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (copy < 0) return fail(env, "open enumeration");
  DIR *directory = fdopendir(copy);
  if (!directory) { int saved = errno; close(copy); errno = saved; return fail(env, "enumerate"); }
  napi_create_array(env, &result);
  uint32_t index = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) { int saved = errno; closedir(directory); if (saved) { errno = saved; return fail(env, "enumerate"); } return result; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    napi_value name;
    if (napi_create_buffer_copy(env, strlen(entry->d_name), entry->d_name, NULL, &name) != napi_ok || napi_set_element(env, result, index++, name) != napi_ok) { closedir(directory); return NULL; }
  }
}

static napi_value duplicate_directory(napi_env env, napi_callback_info info) {
  napi_value args[1]; int fd;
  if (!arguments(env, info, 1, args) || !descriptor(env, args[0], &fd)) return NULL;
  return number_result(env, openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "duplicate directory");
}

static napi_value read_link(napi_env env, napi_callback_info info) {
  napi_value args[2], result; int fd;
  if (!arguments(env, info, 2, args) || !descriptor(env, args[0], &fd)) return NULL;
  char *name = path_value(env, args[1], 1);
  if (!name) return NULL;
  size_t capacity = 256;
  for (;;) {
    char *bytes = malloc(capacity);
    if (!bytes) { free(name); errno = ENOMEM; return fail(env, "allocate link"); }
    ssize_t length = readlinkat(fd, name, bytes, capacity);
    if (length < 0) { int saved = errno; free(bytes); free(name); errno = saved; return fail(env, "read link"); }
    if ((size_t)length < capacity) {
      napi_status status = napi_create_buffer_copy(env, (size_t)length, bytes, NULL, &result);
      free(bytes); free(name);
      return status == napi_ok ? result : NULL;
    }
    free(bytes);
    if (capacity >= 1048576) { free(name); errno = EINVAL; return fail(env, "link exceeds byte limit"); }
    capacity *= 2;
  }
}

static napi_value symlink_at(napi_env env, napi_callback_info info) {
  napi_value args[3]; int fd;
  if (!arguments(env, info, 3, args) || !descriptor(env, args[1], &fd)) return NULL;
  char *target = path_value(env, args[0], 0);
  if (!target) return NULL;
  char *name = path_value(env, args[2], 1);
  if (!name) { free(target); return NULL; }
  int result = symlinkat(target, fd, name);
  int saved = errno; free(target); free(name); errno = saved;
  return number_result(env, result, "create link");
}

static napi_value link_at(napi_env env, napi_callback_info info) {
  napi_value args[4]; int source, destination;
  if (!arguments(env, info, 4, args) || !descriptor(env, args[0], &source) || !descriptor(env, args[2], &destination)) return NULL;
  char *from = path_value(env, args[1], 1);
  if (!from) return NULL;
  char *to = path_value(env, args[3], 1);
  if (!to) { free(from); return NULL; }
  int result = linkat(source, from, destination, to, 0);
  int saved = errno; free(from); free(to); errno = saved;
  return number_result(env, result, "link");
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
    {"openDirectoryAt", NULL, open_directory, NULL, NULL, NULL, napi_default, NULL},
    {"openFileAt", NULL, open_file, NULL, NULL, NULL, napi_default, NULL},
    {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
    {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
    {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
    {"readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default, NULL},
    {"duplicateDirectory", NULL, duplicate_directory, NULL, NULL, NULL, napi_default, NULL},
    {"readLinkAt", NULL, read_link, NULL, NULL, NULL, napi_default, NULL},
    {"symlinkAt", NULL, symlink_at, NULL, NULL, NULL, napi_default, NULL},
    {"linkAt", NULL, link_at, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties);
  return exports;
}
NAPI_MODULE(rae_fs_bridge, initialize)
