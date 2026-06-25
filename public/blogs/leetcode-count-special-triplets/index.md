## 题目描述

给你一个整数数组 `nums`。

**特殊三元组 **定义为满足以下条件的下标三元组 `(i, j, k)`：

	- `0 <= i < j < k < n`，其中 `n = nums.length`

	- `nums[i] == nums[j] * 2`

	- `nums[k] == nums[j] * 2`

返回数组中 **特殊三元组 **的总数。

由于答案可能非常大，请返回结果对 `10^9 + 7` 取余数后的值。

 

示例 1：

**输入：** nums = [6,3,6]

**输出：** 1

**解释：**

唯一的特殊三元组是 `(i, j, k) = (0, 1, 2)`，其中：

	- `nums[0] = 6`, `nums[1] = 3`, `nums[2] = 6`

	- `nums[0] = nums[1] * 2 = 3 * 2 = 6`

	- `nums[2] = nums[1] * 2 = 3 * 2 = 6`

示例 2：

**输入：** nums = [0,1,0,0]

**输出：** 1

**解释：**

唯一的特殊三元组是 `(i, j, k) = (0, 2, 3)`，其中：

	- `nums[0] = 0`, `nums[2] = 0`, `nums[3] = 0`

	- `nums[0] = nums[2] * 2 = 0 * 2 = 0`

	- `nums[3] = nums[2] * 2 = 0 * 2 = 0`

示例 3：

**输入：** nums = [8,4,2,8,4]

**输出：** 2

**解释：**

共有两个特殊三元组：

	- `(i, j, k) = (0, 1, 3)`

	
		`nums[0] = 8`, `nums[1] = 4`, `nums[3] = 8`

		- `nums[0] = nums[1] * 2 = 4 * 2 = 8`

		- `nums[3] = nums[1] * 2 = 4 * 2 = 8`

	
	
	`(i, j, k) = (1, 2, 4)`
	
		- `nums[1] = 4`, `nums[2] = 2`, `nums[4] = 4`

		- `nums[1] = nums[2] * 2 = 2 * 2 = 4`

		- `nums[4] = nums[2] * 2 = 2 * 2 = 4`

	
	

 

**提示：**

	- `3 <= n == nums.length <= 105`

	- `0 <= nums[i] <= 105`

## 解法

```java
class Solution {
    public int specialTriplets(int[] nums) {
        Map<Integer, Integer> left = new HashMap<>();
        Map<Integer, Integer> right = new HashMap<>();

        // 右边初始化：统计 nums[1..n-1]
        for (int i = 1; i < nums.length; i++) {
            right.merge(nums[i], 1, Integer::sum);
        }

        // 左边初始放入 nums[0]
        left.merge(nums[0], 1, Integer::sum);

        long ans = 0;
        final int MOD = 1000000007;

        for (int j = 1; j < nums.length - 1; j++) {
            int val = nums[j];

            // 从右边移除当前元素（当计数归零时，返回 null 删除该键）
            right.merge(val, -1, (oldVal, delta) -> {
                int newVal = oldVal + delta;
                return newVal == 0 ? null : newVal;
            });

            int target = val * 2;
            int leftCount = left.getOrDefault(target, 0);
            int rightCount = right.getOrDefault(target, 0);

            ans = (ans + (long) leftCount * rightCount) % MOD;

            // 将当前元素加入左边
            left.merge(val, 1, Integer::sum);
        }

        return (int) ans;
    }
}

```
