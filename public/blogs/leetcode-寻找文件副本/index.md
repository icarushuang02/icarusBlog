## 题目描述

设备中存有 `n` 个文件，文件 `id` 记于数组 `documents`。若文件 `id` 相同，则定义为该文件存在副本。请返回任一存在副本的文件 `id`。

 

**示例 1：**

```
**输入：**documents = [2, 5, 3, 0, 5, 0]
**输出：**0 或 5
```

 

**提示：**

	- `0 ≤ documents[i] ≤ n-1`

	- `2 <= n <= 100000`

## 解法

```java
class Solution {
    public int findRepeatNumber(int[] nums) {
        Set<Integer> dic = new HashSet<>();
        for(int num : nums) {
            if(dic.contains(num)) return num;
            dic.add(num);
        }
        return -1;
    }
}
```
